// --- Model Configuration ---
const FAL_MODEL_CONFIG = {
  "imagen4-preview": { // Client-facing ID
    submitUrl: 'https://queue.fal.run/fal-ai/imagen4/preview',
    statusBaseUrl: 'https://queue.fal.run/fal-ai/imagen4',
    logName: 'Imagen4 Preview' // For logging
  },
  "flux-1.1-pro-ultra": { // Client-facing ID as requested
    submitUrl: 'https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra',
    statusBaseUrl: 'https://queue.fal.run/fal-ai/flux-pro',
    logName: 'flux-1.1-pro-ultra' // For logging
  }
};
const DEFAULT_MODEL_ID = "imagen4-preview"; // Default model if not specified in request

const EXPECTED_AUTH_HEADER_PREFIX = "Bearer ";

export default {
  async fetch(request, env, ctx) {
    // 1. Worker Access Key Authentication
    const workerAccessKey = env.WORKER_ACCESS_KEY;
    if (!workerAccessKey) {
      console.error("WORKER_ACCESS_KEY is not configured in environment variables.");
      return new Response(JSON.stringify({ error: { message: "Worker access key not configured.", type: "configuration_error" } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith(EXPECTED_AUTH_HEADER_PREFIX)) {
      return new Response(JSON.stringify({ error: { message: "Missing or invalid Authorization header. Expected 'Bearer YOUR_ACCESS_KEY'.", type: "authentication_error" } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const providedToken = authHeader.substring(EXPECTED_AUTH_HEADER_PREFIX.length);
    if (providedToken !== workerAccessKey) {
      return new Response(JSON.stringify({ error: { message: "Invalid access token.", type: "authentication_error" } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    // --- End of Worker Access Key Authentication ---

    const url = new URL(request.url);
    const path = url.pathname;
    const falApiKey = env.FAL_API_KEY;

    if (!falApiKey) {
      return new Response(JSON.stringify({ error: { message: "FAL_API_KEY is not configured.", type: "configuration_error" } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/v1/images/generations' && request.method === 'POST') {
      return handleImageGenerations(request, falApiKey, ctx);
    } else if (path === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletionsForImage(request, falApiKey, ctx);
    } else if (path === '/v1/models' && request.method === 'GET') {
      return listModels();
    } else {
      return new Response(JSON.stringify({ error: { message: "Not Found", type: "not_found_error" } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
  }
};

function getModelConfigFromRequest(requestedModelId) {
  let clientModelId = requestedModelId;
  if (!clientModelId) {
    clientModelId = DEFAULT_MODEL_ID;
    console.log(`No model specified in request, defaulting to ${clientModelId}`);
  }

  const config = FAL_MODEL_CONFIG[clientModelId];
  if (!config) {
    return { error: `Unsupported model: ${clientModelId}. Supported models are: ${Object.keys(FAL_MODEL_CONFIG).join(', ')}` };
  }
  return { ...config, clientModelId }; // Return config and the ID used by client
}

async function handleImageGenerations(request, falApiKey, ctx) {
  let openaiRequest;
  try {
    openaiRequest = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { prompt, n = 1, size = "1024x1024", response_format = "url", model: requestedModelId } = openaiRequest;

  const modelDetails = getModelConfigFromRequest(requestedModelId);
  if (modelDetails.error) {
    return new Response(JSON.stringify({ error: { message: modelDetails.error, type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const { submitUrl, statusBaseUrl, logName, clientModelId } = modelDetails;

  if (!prompt) {
    return new Response(JSON.stringify({ error: { message: "Parameter 'prompt' is required.", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (response_format !== "url" && response_format !== "b64_json") {
    return new Response(JSON.stringify({ error: { message: "Parameter 'response_format' must be 'url' or 'b64_json'.", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const falRequestBody = {
    prompt: prompt,
    num_images: Math.max(1, Math.min(4, Number(n))), // Assuming max 4 is okay for both, adjust if needed
    aspect_ratio: mapOpenAISizeToFalAspectRatio(size),
  };

  try {
    const falResult = await executeFalImageRequest(falRequestBody, falApiKey, ctx, submitUrl, statusBaseUrl, logName);
    const responseData = await Promise.all(falResult.images.map(async (image) => {
      if (response_format === "b64_json") {
        const imageFetchResponse = await fetch(image.url);
        if (!imageFetchResponse.ok) throw new Error(`Failed to download image from Fal.ai: ${image.url}`);
        const imageBuffer = await imageFetchResponse.arrayBuffer();
        return { b64_json: arrayBufferToBase64(imageBuffer) };
      } else {
        return { url: image.url };
      }
    }));
    // The 'model' field in the response should match the ID from /v1/models
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: responseData, model: clientModelId }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error(`Error in handleImageGenerations for model ${logName}:`, error.message, error.stack);
    return new Response(JSON.stringify({ error: { message: error.message || "Failed to generate image.", type: "api_error" } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleChatCompletionsForImage(request, falApiKey, ctx) {
  let openaiRequest;
  try {
    openaiRequest = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { messages, stream = false, model: requestedModelId } = openaiRequest;

  const modelDetails = getModelConfigFromRequest(requestedModelId);
  if (modelDetails.error) {
    return new Response(JSON.stringify({ error: { message: modelDetails.error, type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const { submitUrl, statusBaseUrl, logName, clientModelId } = modelDetails;


  let userPrompt = "";
  let requestedSizeFromPrompt = null;

  if (messages && Array.isArray(messages) && messages.length > 0) {
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    if (lastUserMessage && typeof lastUserMessage.content === 'string') {
      let tempUserPrompt = lastUserMessage.content;
      const keywordSizeRegex = /\b(size|aspect_ratio|比例)\s*[:=\s：]?\s*(\d+[:\/xX]\d+|\d+:\d+|\d+\/\d+)\b/gi;
      let match;
      let lastKeywordMatch = null;
      while ((match = keywordSizeRegex.exec(tempUserPrompt)) !== null) {
        lastKeywordMatch = { value: match[2], fullMatch: match[0], index: match.index };
      }

      if (lastKeywordMatch) {
        requestedSizeFromPrompt = lastKeywordMatch.value;
        tempUserPrompt = tempUserPrompt.substring(0, lastKeywordMatch.index) +
                         tempUserPrompt.substring(lastKeywordMatch.index + lastKeywordMatch.fullMatch.length);
        tempUserPrompt = tempUserPrompt.replace(/\s\s+/g, ' ').trim();
      } else {
        const patternOnlySizeRegex = /\b(\d+[:\/xX]\d+)\b/gi;
        let potentialPatternMatches = [];
        while ((match = patternOnlySizeRegex.exec(tempUserPrompt)) !== null) {
          const parts = match[1].split(/[:\/xX]/);
          if (parts.length === 2) {
            const num1 = parseInt(parts[0],10);
            const num2 = parseInt(parts[1],10);
            if (num1 > 0 && num1 < 5000 && num2 > 0 && num2 < 5000) {
              potentialPatternMatches.push({ value: match[1], fullMatch: match[0], index: match.index });
            }
          }
        }
        if (potentialPatternMatches.length > 0) {
          const chosenPatternMatch = potentialPatternMatches[potentialPatternMatches.length - 1];
          requestedSizeFromPrompt = chosenPatternMatch.value;
          tempUserPrompt = tempUserPrompt.substring(0, chosenPatternMatch.index) +
                           tempUserPrompt.substring(chosenPatternMatch.index + chosenPatternMatch.fullMatch.length);
          tempUserPrompt = tempUserPrompt.replace(/\s\s+/g, ' ').trim();
        }
      }
      userPrompt = tempUserPrompt;
    }
  }

  if (!userPrompt && !requestedSizeFromPrompt) {
    const defaultMessage = `Please provide a description for the image. You can also specify a ratio, e.g., 'a cat 比例:16:9' or 'a dog 9:16'.`;
    if (stream) return createStreamingChatResponseHelper(generateRandomId(), clientModelId, [{ type: "text", content: defaultMessage }], "stop");
    return new Response(JSON.stringify(createNonStreamingChatResponseHelper(generateRandomId(), clientModelId, defaultMessage, "stop")), { headers: { 'Content-Type': 'application/json' } });
  } else if (!userPrompt && requestedSizeFromPrompt) {
    userPrompt = "image"; 
  }

  const finalSize = requestedSizeFromPrompt || openaiRequest.size || "1024x1024";
  const falRequestBody = {
    prompt: userPrompt,
    num_images: 1,
    aspect_ratio: mapOpenAISizeToFalAspectRatio(finalSize),
  };

  if (stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const chatRequestId = `chatcmpl-${generateRandomId()}`;

    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, clientModelId, { role: "assistant" }, null))}\n\n`));
    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, clientModelId, { content: `🎨 Generating image with prompt: "${userPrompt}" and aspect ratio: ${falRequestBody.aspect_ratio} using ${logName}...` }, null))}\n\n`));

    ctx.waitUntil((async () => {
      try {
        const falResult = await executeFalImageRequest(falRequestBody, falApiKey, ctx, submitUrl, statusBaseUrl, logName);
        const imageUrl = falResult.images && falResult.images[0] ? falResult.images[0].url : null;
        const imageMarkdown = imageUrl ? `\n\nHere is the image:\n\n![Generated Image](${imageUrl})` : `\n\nSorry, I couldn't generate the image with ${logName} this time.`;
        writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, clientModelId, { content: imageMarkdown }, null))}\n\n`));
        writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, clientModelId, {}, "stop"))}\n\n`));
      } catch (error) {
        console.error(`Streaming error for model ${logName}:`, error.message, error.stack);
        try { writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, clientModelId, { content: `\n\nAn error occurred with ${logName}: ${error.message}` }, "stop"))}\n\n`)); } catch (e) {}
      } finally {
        writer.write(encoder.encode('data: [DONE]\n\n'));
        try { await writer.close(); } catch (e) {}
      }
    })());
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
  } else {
    try {
      const falResult = await executeFalImageRequest(falRequestBody, falApiKey, ctx, submitUrl, statusBaseUrl, logName);
      const imageUrl = falResult.images && falResult.images[0] ? falResult.images[0].url : null;
      const responseContent = imageUrl ? `Generated image with prompt: "${userPrompt}" and aspect ratio: ${falRequestBody.aspect_ratio} using ${logName}\n\n![Generated Image](${imageUrl})` : `Sorry, I couldn't generate image with prompt: "${userPrompt}" and aspect ratio: ${falRequestBody.aspect_ratio} using ${logName}.`;
      return new Response(JSON.stringify(createNonStreamingChatResponseHelper(generateRandomId(), clientModelId, responseContent, "stop")), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      console.error(`Non-streaming error for model ${logName}:`, error.message, error.stack);
      return new Response(JSON.stringify(createNonStreamingChatResponseHelper(generateRandomId(), clientModelId, `An error occurred for prompt "${userPrompt}" with aspect ratio ${falRequestBody.aspect_ratio} using ${logName}: ${error.message}`, "stop")), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
}

async function executeFalImageRequest(falRequestBody, falApiKey, ctx, submitUrl, statusBaseUrl, modelLogName) {
  const falSubmitResponse = await fetch(submitUrl, {
    method: 'POST',
    headers: { 'Authorization': `Key ${falApiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(falRequestBody),
  });

  if (!falSubmitResponse.ok) {
    const errorText = await falSubmitResponse.text();
    throw new Error(`Fal.ai API request to ${modelLogName} failed with status ${falSubmitResponse.status}: ${errorText}`);
  }
  const submitResult = await falSubmitResponse.json();
  const requestId = submitResult.request_id;
  if (!requestId) throw new Error(`Fal.ai submission to ${modelLogName} did not yield a request_id.`);
  console.log(`Fal.ai job submitted for ${modelLogName}. Request ID: ${requestId}`);

  const maxAttempts = 45, pollIntervalMs = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const currentStatusUrl = `${statusBaseUrl}/requests/${requestId}/status`;
    let statusData;
    try {
      const statusResponse = await fetch(currentStatusUrl, { headers: { 'Authorization': `Key ${falApiKey}`, 'Accept': 'application/json' } });
      if (!statusResponse.ok) {
        console.warn(`Fal.ai status check for ${modelLogName} (${requestId}) failed (attempt ${attempt + 1}): ${statusResponse.status} ${await statusResponse.text()}. Retrying...`);
        if (attempt > maxAttempts - 5 && statusResponse.status >= 500) throw new Error(`Fal.ai status check for ${modelLogName} (${requestId}) failed repeatedly. Last status: ${statusResponse.status}`);
        continue;
      }
      statusData = await statusResponse.json();
    } catch (e) {
      console.warn(`Network error during Fal.ai status check for ${modelLogName} (${requestId}) (attempt ${attempt + 1}): ${e.message}. Retrying...`);
      continue;
    }
    console.log(`Polling attempt ${attempt + 1}/${maxAttempts} for ${modelLogName} (${requestId}). Status: ${statusData.status}`);
    if (statusData.status === 'COMPLETED') {
      const resultUrl = `${statusBaseUrl}/requests/${requestId}`;
      const resultResponse = await fetch(resultUrl, { headers: { 'Authorization': `Key ${falApiKey}`, 'Accept': 'application/json' } });
      if (resultResponse.ok) {
        const resultData = await resultResponse.json();
        if (!resultData.images || resultData.images.length === 0) throw new Error(`Fal.ai job ${modelLogName} (${requestId}) completed but returned no images.`);
        return resultData;
      } else {
        throw new Error(`Failed to fetch result for completed Fal.ai job ${modelLogName} (${requestId}) (status ${resultResponse.status}): ${await resultResponse.text()}`);
      }
    } else if (statusData.status === 'FAILED' || statusData.status === 'CANCELLED') {
      throw new Error(`Fal.ai request for ${modelLogName} (${requestId}) ${statusData.status}. Logs: ${statusData.logs ? JSON.stringify(statusData.logs) : 'No logs.'}`);
    }
  }
  throw new Error(`Image generation timed out for ${modelLogName} request ${requestId}.`);
}

function mapOpenAISizeToFalAspectRatio(size) {
  if (!size) return "1:1"; 
  const s = String(size).toLowerCase().replace('/', ':');
  switch (s) {
    case "256x256": case "512x512": case "1024x1024": case "1:1": return "1:1";
    case "1792x1024": case "16:9": return "16:9";
    case "1024x1792": case "9:16": return "9:16";
    case "21:9": return "21:9";
    case "4:3": return "4:3";
    case "3:2": return "3:2";
    case "2:3": return "2:3";
    case "3:4": return "3:4";
    case "9:21": return "9:21";
    default:
      const parts = s.split(/[:x]/);
      if (parts.length === 2) {
        const w = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
        if (w && h) {
          const ratio = w / h;
          if (Math.abs(ratio - 1) < 0.05) return "1:1";
          if (Math.abs(ratio - (16/9)) < 0.1) return "16:9";
          if (Math.abs(ratio - (9/16)) < 0.1) return "9:16";
          if (Math.abs(ratio - (4/3)) < 0.1) return "4:3";
          if (Math.abs(ratio - (3/4)) < 0.1) return "3:4";
          if (Math.abs(ratio - (21/9)) < 0.1) return "21:9";
          if (Math.abs(ratio - (9/21)) < 0.1) return "9:21";
          if (Math.abs(ratio - (3/2)) < 0.1) return "3:2";
          if (Math.abs(ratio - (2/3)) < 0.1) return "2:3";
        }
      }
      console.warn(`Unmapped or invalid size '${size}', defaulting to 1:1. Check model aspect_ratio support.`);
      return "1:1"; 
  }
}

async function listModels() {
  const timestamp = Math.floor(Date.now() / 1000);
  const modelList = Object.keys(FAL_MODEL_CONFIG).map(id => ({
    id: id, // This is the client-facing ID
    object: "model",
    created: timestamp,
    owned_by: "fal-ai", // Assuming both are from fal-ai
    permission: [],
    root: id,
    parent: null,
    // display_name: FAL_MODEL_CONFIG[id].logName // Optional: if you want to add a display name field
  }));
  return new Response(JSON.stringify({ object: "list", data: modelList }), { headers: { 'Content-Type': 'application/json' } });
}

function arrayBufferToBase64(buffer) {
  let binary = ''; const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function generateRandomId(length = 24) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

// modelId here is the client-facing ID (e.g., "flux-1.1-pro-ultra")
function createChatChunk(requestId, modelId, delta, finishReason) {
  return { id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: delta, finish_reason: finishReason }] };
}

function createNonStreamingChatResponseHelper(chatRequestId, modelId, content, finishReason) {
  const id = chatRequestId ? `chatcmpl-${chatRequestId}` : `chatcmpl-${generateRandomId()}`;
  return { id: id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: finishReason }], usage: { prompt_tokens: Math.ceil((content.length||0)/4), completion_tokens: Math.ceil((content.length||0)/2), total_tokens: Math.ceil((content.length||0)*0.75) } };
}

function createStreamingChatResponseHelper(chatRequestId, modelId, contentChunks, finalFinishReason) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter(); const encoder = new TextEncoder();
  const id = chatRequestId ? `chatcmpl-${chatRequestId}` : `chatcmpl-${generateRandomId()}`;
  (async () => {
    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(id, modelId, { role: "assistant" }, null))}\n\n`));
    for (const chunk of contentChunks) if (chunk.type === "text") writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(id, modelId, { content: chunk.content }, null))}\n\n`));
    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(id, modelId, {}, finalFinishReason))}\n\n`));
    writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
  })();
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}
