const Groq = require('groq-sdk');
const pdfParse = require('pdf-parse');

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 30000;
const QUESTION_COUNT = 10;
const FALLBACK_MODEL = 'openai/gpt-oss-120b';

function createError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function readHeader(req, headerName, fallback) {
  const value = req.headers[headerName];
  if (typeof value !== 'string') {
    return fallback;
  }

  const cleaned = value.trim();
  return cleaned || fallback;
}

function parseBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }

      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += chunkBuffer.length;

      if (totalBytes > maxBytes) {
        tooLarge = true;
        reject(createError(413, `PDF is too large. Maximum allowed size is ${Math.floor(maxBytes / (1024 * 1024))}MB.`));
        return;
      }

      chunks.push(chunkBuffer);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(createError(400, 'Failed to read uploaded PDF.', error.message)));
    req.on('aborted', () => reject(createError(499, 'Request was aborted before upload completed.')));
  });
}

function sanitizeModelJson(raw) {
  const text = String(raw || '').trim();

  if (!text) {
    throw createError(502, 'Model returned an empty response.');
  }

  const withoutFences = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const firstBracket = withoutFences.indexOf('[');
  const lastBracket = withoutFences.lastIndexOf(']');

  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw createError(502, 'Model response did not contain a valid JSON array.');
  }

  return withoutFences.slice(firstBracket, lastBracket + 1);
}

function normalizeQuestion(question, index) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    throw createError(502, `Invalid question at index ${index}: expected an object.`);
  }

  const prompt = typeof question.question === 'string' ? question.question.trim() : '';
  if (!prompt) {
    throw createError(502, `Invalid question at index ${index}: missing question text.`);
  }

  if (!Array.isArray(question.options) || question.options.length !== 4) {
    throw createError(502, `Invalid question at index ${index}: options must be exactly 4 items.`);
  }

  const options = question.options.map((option, optionIndex) => {
    if (typeof option !== 'string' || !option.trim()) {
      throw createError(502, `Invalid option ${optionIndex} at question index ${index}: option must be a non-empty string.`);
    }
    return option.trim();
  });

  const answerIndex = Number(question.answerIndex);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
    throw createError(502, `Invalid answerIndex at question index ${index}: must be an integer between 0 and 3.`);
  }

  const explanationSource = typeof question.explanation === 'string' ? question.explanation : '';
  const explanation = explanationSource.trim() || 'No explanation provided.';

  return {
    question: prompt,
    options,
    answerIndex,
    explanation
  };
}

async function requestQuizFromGroq({ extractedText, subject, language }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw createError(500, 'Missing GROQ_API_KEY environment variable.');
  }

  const groq = new Groq({ apiKey });
  const model = process.env.GROQ_MODEL || FALLBACK_MODEL;

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'You generate strictly valid JSON arrays for MCQ quizzes. Do not include markdown, comments, or extra text.'
      },
      {
        role: 'user',
        content: `Subject: ${subject}\nLanguage: ${language}\n\nGenerate exactly ${QUESTION_COUNT} multiple-choice questions from the study material below.\n\nRules:\n1) Return ONLY a JSON array (no markdown fences).\n2) The array length must be exactly ${QUESTION_COUNT}.\n3) Each item must follow this schema:\n{\n  "question": "string",\n  "options": ["string", "string", "string", "string"],\n  "answerIndex": 0,\n  "explanation": "string"\n}\n4) answerIndex must be an integer from 0 to 3.\n5) Keep explanations short and clear.\n\nStudy material:\n${extractedText}`
      }
    ]
  });

  const rawContent = completion && completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.content
    : '';

  let parsed;
  try {
    parsed = JSON.parse(sanitizeModelJson(rawContent));
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    throw createError(502, 'Model returned malformed JSON.', error.message);
  }

  if (!Array.isArray(parsed)) {
    throw createError(502, 'Model output JSON must be an array.');
  }

  if (parsed.length !== QUESTION_COUNT) {
    throw createError(502, `Model must return exactly ${QUESTION_COUNT} questions, received ${parsed.length}.`);
  }

  return parsed.map((question, index) => normalizeQuestion(question, index));
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.includes('application/pdf')) {
      throw createError(400, 'Invalid content type. Expected application/pdf.');
    }

    const pdfBuffer = await parseBuffer(req, MAX_PDF_BYTES);
    if (!pdfBuffer || !pdfBuffer.length) {
      throw createError(400, 'No PDF file uploaded.');
    }

    const pdfHeader = pdfBuffer.subarray(0, 1024).toString('latin1');
    if (!pdfHeader.includes('%PDF-')) {
      throw createError(400, 'Invalid PDF file. Please upload a valid PDF document.');
    }

    let extractedText = '';
    try {
      const parsedPdf = await pdfParse(pdfBuffer);
      extractedText = String(parsedPdf && parsedPdf.text ? parsedPdf.text : '').replace(/\s+/g, ' ').trim();
    } catch (error) {
      throw createError(400, 'Could not parse PDF file.', error.message);
    }

    if (!extractedText) {
      throw createError(400, 'Uploaded PDF does not contain readable text.');
    }

    const subject = readHeader(req, 'x-subject', 'General Knowledge');
    const language = readHeader(req, 'x-language', 'English');

    const questions = await requestQuizFromGroq({
      extractedText: extractedText.slice(0, MAX_TEXT_CHARS),
      subject,
      language
    });

    return res.status(200).json({ success: true, questions });
  } catch (error) {
    const statusCode = error.statusCode || (error.status === 404 ? 502 : 500);
    const response = {
      success: false,
      error: error.message || 'Unexpected server error.'
    };

    if (error.details) {
      response.details = error.details;
    }

    if (statusCode >= 500) {
      const upstreamMessage = error && error.response && error.response.error && error.response.error.message;
      if (upstreamMessage) {
        response.details = upstreamMessage;
      }
    }

    return res.status(statusCode).json(response);
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
