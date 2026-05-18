const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const OpenAI = require('openai');
const TelegramBot = require('node-telegram-bot-api');
const FFMPEG = require('ffmpeg-static');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SUMMARIES_DIR = path.join(__dirname, 'summaries');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
const CHUNKS_DIR = path.join(__dirname, 'chunks');

[UPLOAD_DIR, SUMMARIES_DIR, TRANSCRIPTS_DIR, CHUNKS_DIR].forEach(d => {
  fs.mkdirSync(d, { recursive: true });
});

// Multer config - 2GB limit
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${ts}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Telegram bot (polling disabled, send-only)
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
}

// Server timeout 30 min
app.use((req, res, next) => {
  req.setTimeout(30 * 60 * 1000);
  res.setTimeout(30 * 60 * 1000);
  next();
});

// ---- HTML page ----
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meeting Notes</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .container {
    width: 100%;
    max-width: 480px;
    text-align: center;
  }
  h1 {
    font-size: 1.6rem;
    margin-bottom: 8px;
    color: #fff;
  }
  .subtitle {
    font-size: 0.9rem;
    color: #888;
    margin-bottom: 32px;
  }
  .upload-area {
    border: 2px dashed #444;
    border-radius: 16px;
    padding: 40px 20px;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    margin-bottom: 20px;
  }
  .upload-area:hover, .upload-area.dragover {
    border-color: #6c63ff;
    background: rgba(108, 99, 255, 0.05);
  }
  .upload-area .icon { font-size: 3rem; margin-bottom: 12px; }
  .upload-area p { font-size: 1rem; color: #aaa; }
  .file-name {
    font-size: 0.85rem;
    color: #6c63ff;
    margin-top: 8px;
    word-break: break-all;
  }
  input[type="file"] { display: none; }
  .btn {
    display: inline-block;
    background: #6c63ff;
    color: #fff;
    border: none;
    padding: 14px 40px;
    font-size: 1.05rem;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s, opacity 0.2s;
    width: 100%;
    max-width: 300px;
  }
  .btn:hover { background: #5a52d5; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .progress-wrap {
    display: none;
    margin-top: 24px;
  }
  .progress-bar-bg {
    background: #2a2a4a;
    border-radius: 8px;
    height: 10px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .progress-bar {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #6c63ff, #48c6ef);
    border-radius: 8px;
    transition: width 0.3s;
  }
  .progress-text {
    font-size: 0.85rem;
    color: #aaa;
  }
  .status {
    margin-top: 24px;
    font-size: 1rem;
    min-height: 1.5em;
  }
  .status.success { color: #4caf50; }
  .status.error { color: #ef5350; }
  .formats {
    font-size: 0.75rem;
    color: #555;
    margin-top: 24px;
  }
</style>
</head>
<body>
<div class="container">
  <h1>Meeting Notes</h1>
  <p class="subtitle">Upload audio to transcribe and summarize</p>

  <div class="upload-area" id="dropArea">
    <div class="icon">🎙️</div>
    <p>Click to choose or drop audio file</p>
    <div class="file-name" id="fileName"></div>
  </div>
  <input type="file" id="fileInput"
    accept=".m4a,.caf,.mp3,.wav,.webm,.mp4,.ogg,.aac,.flac,audio/*">

  <button class="btn" id="uploadBtn" disabled>Upload</button>

  <div class="progress-wrap" id="progressWrap">
    <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
    <div class="progress-text" id="progressText">0%</div>
  </div>

  <div class="status" id="status"></div>
  <div class="formats">m4a, caf, mp3, wav, webm, mp4, ogg, aac, flac — up to 2 GB</div>
</div>

<script>
  const dropArea = document.getElementById('dropArea');
  const fileInput = document.getElementById('fileInput');
  const fileName = document.getElementById('fileName');
  const uploadBtn = document.getElementById('uploadBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const status = document.getElementById('status');
  let selectedFile = null;

  dropArea.addEventListener('click', () => fileInput.click());
  dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('dragover'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
  dropArea.addEventListener('drop', e => {
    e.preventDefault();
    dropArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) selectFile(fileInput.files[0]);
  });

  function selectFile(file) {
    selectedFile = file;
    fileName.textContent = file.name + ' (' + formatSize(file.size) + ')';
    uploadBtn.disabled = false;
    status.textContent = '';
    status.className = 'status';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  uploadBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    const formData = new FormData();
    formData.append('audio', selectedFile);
    formData.append('fileLastModified', selectedFile.lastModified);
    formData.append('originalName', selectedFile.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.timeout = 30 * 60 * 1000;

    uploadBtn.disabled = true;
    progressWrap.style.display = 'block';
    status.textContent = '';
    status.className = 'status';

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        progressBar.style.width = pct + '%';
        progressText.textContent = pct + '% (' + formatSize(e.loaded) + ' / ' + formatSize(e.total) + ')';
      }
    });

    xhr.addEventListener('load', () => {
      progressBar.style.width = '100%';
      progressText.textContent = '100%';
      if (xhr.status === 200) {
        status.textContent = 'Итоги придут в Telegram';
        status.className = 'status success';
      } else {
        let msg = 'Error';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch(e) {}
        status.textContent = msg;
        status.className = 'status error';
      }
      uploadBtn.disabled = false;
    });

    xhr.addEventListener('error', () => {
      status.textContent = 'Network error';
      status.className = 'status error';
      uploadBtn.disabled = false;
    });

    xhr.addEventListener('timeout', () => {
      status.textContent = 'Timeout';
      status.className = 'status error';
      uploadBtn.disabled = false;
    });

    xhr.send(formData);
  });
</script>
</body>
</html>`;

// ---- Routes ----

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_PAGE);
});

app.post('/upload', upload.single('audio'), async (req, res) => {
  const startTime = Date.now();
  let uploadedPath = null;
  let mp3Path = null;
  let chunkPaths = [];

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    uploadedPath = req.file.path;
    const originalName = req.body.originalName || req.file.originalname || 'recording';
    const fileLastModified = req.body.fileLastModified
      ? new Date(parseInt(req.body.fileLastModified))
      : new Date();

    const dateStr = formatDate(fileLastModified);
    const sessionId = Date.now().toString(36);

    console.log(`[${sessionId}] Received: ${originalName} (${(req.file.size / 1048576).toFixed(1)} MB)`);

    // 1. Convert to mp3
    console.log(`[${sessionId}] Converting to mp3...`);
    mp3Path = path.join(UPLOAD_DIR, `${sessionId}.mp3`);
    await convertToMp3(uploadedPath, mp3Path);

    const mp3Size = fs.statSync(mp3Path).size;
    console.log(`[${sessionId}] MP3 size: ${(mp3Size / 1048576).toFixed(1)} MB`);

    // 2. Split if needed
    let audioPaths;
    if (mp3Size > 20 * 1024 * 1024) {
      console.log(`[${sessionId}] Splitting into chunks...`);
      audioPaths = await splitAudio(mp3Path, sessionId);
      chunkPaths = audioPaths;
      console.log(`[${sessionId}] Split into ${audioPaths.length} chunks`);
    } else {
      audioPaths = [mp3Path];
    }

    // 3. Transcribe
    console.log(`[${sessionId}] Transcribing ${audioPaths.length} file(s)...`);
    const transcriptParts = [];
    for (let i = 0; i < audioPaths.length; i++) {
      console.log(`[${sessionId}] Transcribing part ${i + 1}/${audioPaths.length}...`);
      const text = await transcribeAudio(audioPaths[i]);
      transcriptParts.push(text);
    }
    const fullTranscript = transcriptParts.join('\n\n');
    console.log(`[${sessionId}] Transcript length: ${fullTranscript.length} chars`);

    // Save transcript
    const transcriptFile = path.join(TRANSCRIPTS_DIR, `${sessionId}_${dateStr}.txt`);
    fs.writeFileSync(transcriptFile, fullTranscript, 'utf8');

    // Respond to client early
    res.json({ ok: true, message: 'Processing complete, sending to Telegram' });

    // 4. Analyze with GPT-4o
    console.log(`[${sessionId}] Analyzing with GPT-4o...`);
    const analysis = await analyzeTranscript(fullTranscript, dateStr, originalName);

    // Save summary
    const summaryData = {
      sessionId,
      date: dateStr,
      originalFile: originalName,
      fileLastModified: fileLastModified.toISOString(),
      processedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - startTime) / 1000),
      transcriptLength: fullTranscript.length,
      analysis
    };
    const summaryFile = path.join(SUMMARIES_DIR, `${sessionId}_${dateStr}.json`);
    fs.writeFileSync(summaryFile, JSON.stringify(summaryData, null, 2), 'utf8');

    // 5. Send to Telegram
    console.log(`[${sessionId}] Sending to Telegram...`);
    await sendToTelegram(analysis, dateStr);
    console.log(`[${sessionId}] Done in ${Math.round((Date.now() - startTime) / 1000)}s`);

  } catch (err) {
    console.error('Processing error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Processing failed' });
    }
  } finally {
    // Cleanup temp files
    cleanup(uploadedPath);
    cleanup(mp3Path);
    chunkPaths.forEach(cleanup);
  }
});

// ---- Helpers ----

function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  }
}

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${yyyy}-${mm}-${dd}`;
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '64k',
      '-f', 'mp3',
      '-y',
      outputPath
    ];
    execFile(FFMPEG, args, { timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg stderr:', stderr);
        return reject(new Error('Audio conversion failed: ' + (err.message || '')));
      }
      resolve();
    });
  });
}

function splitAudio(mp3Path, sessionId) {
  return new Promise((resolve, reject) => {
    const chunkPattern = path.join(CHUNKS_DIR, `${sessionId}_chunk_%03d.mp3`);
    const args = [
      '-i', mp3Path,
      '-f', 'segment',
      '-segment_time', '600',
      '-c', 'copy',
      '-y',
      chunkPattern
    ];
    execFile(FFMPEG, args, { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg split stderr:', stderr);
        return reject(new Error('Audio split failed'));
      }
      // Collect chunk files
      const chunks = [];
      for (let i = 0; i < 999; i++) {
        const chunkPath = path.join(CHUNKS_DIR, `${sessionId}_chunk_${String(i).padStart(3, '0')}.mp3`);
        if (fs.existsSync(chunkPath)) {
          chunks.push(chunkPath);
        } else {
          break;
        }
      }
      if (chunks.length === 0) {
        return reject(new Error('No chunks created'));
      }
      resolve(chunks);
    });
  });
}

async function transcribeAudio(audioPath) {
  const fileStream = fs.createReadStream(audioPath);
  const response = await openai.audio.transcriptions.create({
    model: 'gpt-4o-transcribe',
    file: fileStream,
    response_format: 'text',
    language: 'ru'
  });
  return response;
}

async function analyzeTranscript(transcript, dateStr, originalName) {
  const prompt = `You are an expert meeting analyst. Analyze the following meeting transcript (in Russian) and produce a structured summary in Russian.

Meeting date: ${dateStr}
Original file name: ${originalName}

Return the analysis in the following exact format (skip any section that has no relevant content):

НАЗВАНИЕ: [concise meeting name/topic derived from the content, not from file name]

ТЕМА: [main topic or agenda in 1-2 sentences]

ИТОГИ: [brief overall summary in 2-4 sentences]

РЕШЕНИЯ:
- [decision 1]
- [decision 2]

ЗАДАЧИ:
- [person] — [task] — [deadline if mentioned]

ВАЖНО:
- [risk or important note 1]

ИДЕИ:
- [idea 1]

Transcript:
${transcript.substring(0, 120000)}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }]
  });

  return response.choices[0].message.content;
}

async function sendToTelegram(analysis, dateStr) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured, skipping');
    return;
  }

  // Extract meeting name from analysis
  let meetingName = 'Meeting';
  const nameMatch = analysis.match(/НАЗВАНИЕ:\s*(.+)/);
  if (nameMatch) {
    meetingName = nameMatch[1].trim();
  }

  const message = `🎙 ${meetingName}\n📅 ${dateStr}\n\n${analysis}`;

  // Telegram has a 4096 char limit per message
  const MAX_LEN = 4000;
  if (message.length <= MAX_LEN) {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
  } else {
    // Split into multiple messages
    const parts = splitText(message, MAX_LEN);
    for (const part of parts) {
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, part);
    }
  }
}

function splitText(text, maxLen) {
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) {
      // No good newline found, split at space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    parts.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }
  return parts;
}

// ---- Image upscaling ----

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  }
});

const UPSCALE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Image Upscaler</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .container { width: 100%; max-width: 520px; text-align: center; }
  h1 { font-size: 1.6rem; margin-bottom: 8px; color: #fff; }
  .subtitle { font-size: 0.9rem; color: #888; margin-bottom: 32px; }
  .upload-area {
    border: 2px dashed #444;
    border-radius: 16px;
    padding: 40px 20px;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    margin-bottom: 20px;
  }
  .upload-area:hover, .upload-area.dragover {
    border-color: #6c63ff;
    background: rgba(108,99,255,0.05);
  }
  .upload-area .icon { font-size: 3rem; margin-bottom: 12px; }
  .upload-area p { font-size: 1rem; color: #aaa; }
  .file-name { font-size: 0.85rem; color: #6c63ff; margin-top: 8px; word-break: break-all; }
  input[type="file"] { display: none; }
  .preview-wrap { margin-bottom: 20px; display: none; }
  .preview-wrap img { max-width: 100%; max-height: 240px; border-radius: 10px; border: 1px solid #333; }
  .preview-info { font-size: 0.8rem; color: #666; margin-top: 6px; }
  .scale-row {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-bottom: 20px;
  }
  .scale-btn {
    flex: 1;
    max-width: 100px;
    padding: 10px;
    border: 2px solid #444;
    border-radius: 10px;
    background: transparent;
    color: #aaa;
    font-size: 1rem;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
  }
  .scale-btn.active { border-color: #6c63ff; color: #fff; background: rgba(108,99,255,0.15); }
  .btn {
    display: inline-block;
    background: #6c63ff;
    color: #fff;
    border: none;
    padding: 14px 40px;
    font-size: 1.05rem;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s, opacity 0.2s;
    width: 100%;
    max-width: 300px;
  }
  .btn:hover { background: #5a52d5; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .status { margin-top: 24px; font-size: 1rem; min-height: 1.5em; }
  .status.success { color: #4caf50; }
  .status.error { color: #ef5350; }
  .formats { font-size: 0.75rem; color: #555; margin-top: 24px; }
  .result-wrap { display: none; margin-top: 24px; }
  .result-wrap img { max-width: 100%; border-radius: 10px; border: 1px solid #333; margin-bottom: 12px; }
  .download-btn {
    display: inline-block;
    background: #4caf50;
    color: #fff;
    border: none;
    padding: 12px 32px;
    font-size: 1rem;
    border-radius: 10px;
    cursor: pointer;
    text-decoration: none;
    transition: background 0.2s;
  }
  .download-btn:hover { background: #388e3c; }
</style>
</head>
<body>
<div class="container">
  <h1>Image Upscaler</h1>
  <p class="subtitle">Увеличьте разрешение изображения в 2x, 3x или 4x</p>

  <div class="upload-area" id="dropArea">
    <div class="icon">🖼️</div>
    <p>Нажмите или перетащите изображение</p>
    <div class="file-name" id="fileName"></div>
  </div>
  <input type="file" id="fileInput" accept="image/jpeg,image/png,image/webp,image/tiff,image/gif">

  <div class="preview-wrap" id="previewWrap">
    <img id="previewImg" src="" alt="preview">
    <div class="preview-info" id="previewInfo"></div>
  </div>

  <div class="scale-row">
    <button class="scale-btn active" data-scale="2">2×</button>
    <button class="scale-btn" data-scale="3">3×</button>
    <button class="scale-btn" data-scale="4">4×</button>
    <button class="scale-btn" data-scale="6">6×</button>
    <button class="scale-btn" data-scale="8">8×</button>
  </div>

  <label style="display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:16px;font-size:0.9rem;color:#aaa;cursor:pointer;">
    <input type="checkbox" id="printMode" style="width:16px;height:16px;accent-color:#6c63ff;">
    Режим печати — TIFF без потерь (для баннеров)
  </label>

  <button class="btn" id="upscaleBtn" disabled>Увеличить</button>

  <div class="status" id="status"></div>

  <div class="result-wrap" id="resultWrap">
    <img id="resultImg" src="" alt="upscaled">
    <br>
    <a class="download-btn" id="downloadBtn" href="#" download>Скачать</a>
  </div>

  <div class="formats">JPEG, PNG, WebP, TIFF — до 50 МБ</div>
</div>
<script>
  const dropArea = document.getElementById('dropArea');
  const fileInput = document.getElementById('fileInput');
  const fileName = document.getElementById('fileName');
  const upscaleBtn = document.getElementById('upscaleBtn');
  const status = document.getElementById('status');
  const previewWrap = document.getElementById('previewWrap');
  const previewImg = document.getElementById('previewImg');
  const previewInfo = document.getElementById('previewInfo');
  const resultWrap = document.getElementById('resultWrap');
  const resultImg = document.getElementById('resultImg');
  const downloadBtn = document.getElementById('downloadBtn');
  const printModeChk = document.getElementById('printMode');
  let selectedFile = null;
  let selectedScale = 2;

  document.querySelectorAll('.scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedScale = parseInt(btn.dataset.scale);
    });
  });

  dropArea.addEventListener('click', () => fileInput.click());
  dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('dragover'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
  dropArea.addEventListener('drop', e => {
    e.preventDefault();
    dropArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) selectFile(fileInput.files[0]); });

  function selectFile(file) {
    selectedFile = file;
    fileName.textContent = file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)';
    upscaleBtn.disabled = false;
    status.textContent = '';
    status.className = 'status';
    resultWrap.style.display = 'none';

    const reader = new FileReader();
    reader.onload = e => {
      previewImg.src = e.target.result;
      previewWrap.style.display = 'block';
      const img = new Image();
      img.onload = () => { previewInfo.textContent = img.width + ' × ' + img.height + ' px'; };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  upscaleBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    upscaleBtn.disabled = true;
    status.textContent = 'Обработка...';
    status.className = 'status';
    resultWrap.style.display = 'none';

    const formData = new FormData();
    formData.append('image', selectedFile);
    formData.append('scale', selectedScale);
    if (printModeChk.checked) formData.append('print', '1');

    try {
      const resp = await fetch('/upscale', { method: 'POST', body: formData });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Ошибка сервера');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const ext = resp.headers.get('X-Output-Format') || 'png';
      const outW = resp.headers.get('X-Output-Width');
      const outH = resp.headers.get('X-Output-Height');
      const baseName = selectedFile.name.replace(/\\.[^.]+$/, '');

      if (ext !== 'tiff') {
        resultImg.src = url;
        resultWrap.style.display = 'block';
      }
      downloadBtn.href = url;
      downloadBtn.download = baseName + '_' + selectedScale + 'x.' + ext;

      const sizeInfo = outW && outH ? outW + ' × ' + outH + ' px' : '';
      status.textContent = 'Готово! ' + sizeInfo + (ext === 'tiff' ? ' (TIFF)' : '');
      status.className = 'status success';
    } catch (e) {
      status.textContent = e.message;
      status.className = 'status error';
    } finally {
      upscaleBtn.disabled = false;
    }
  });
</script>
</body>
</html>`;

app.get('/upscale', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(UPSCALE_HTML);
});

app.post('/upscale', imageUpload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded or unsupported format' });
  }

  const scale = Math.min(8, Math.max(1, parseInt(req.body.scale) || 2));
  const mime = req.file.mimetype;
  // Always output TIFF for print when scale >= 3 to preserve maximum quality
  const printMode = req.body.print === '1';

  let fmt;
  if (printMode && scale >= 3) fmt = 'tiff';
  else if (mime === 'image/png') fmt = 'png';
  else if (mime === 'image/webp') fmt = 'webp';
  else if (mime === 'image/tiff') fmt = 'tiff';
  else fmt = 'jpeg';

  const outMime = fmt === 'tiff' ? 'image/tiff' : mime;

  try {
    const metadata = await sharp(req.file.buffer).metadata();
    const newWidth = Math.round(metadata.width * scale);
    const newHeight = Math.round(metadata.height * scale);

    // For large upscales, do two passes to reduce Lanczos ringing artifacts
    let pipeline = sharp(req.file.buffer);
    if (scale >= 3) {
      const midWidth = Math.round(metadata.width * 2);
      const midHeight = Math.round(metadata.height * 2);
      const midBuf = await pipeline
        .resize(midWidth, midHeight, { kernel: sharp.kernel.lanczos3 })
        .toFormat('png')
        .toBuffer();
      pipeline = sharp(midBuf);
    }

    const formatOpts = fmt === 'tiff'
      ? { compression: 'lzw', predictor: 'horizontal' }
      : fmt === 'jpeg'
        ? { quality: 97, chromaSubsampling: '4:4:4' }
        : fmt === 'png'
          ? { compressionLevel: 6 }
          : { quality: 97 };

    const outputBuffer = await pipeline
      .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
      .sharpen({ sigma: 0.6, m1: 0.5, m2: 2.5 })
      .toFormat(fmt, formatOpts)
      .toBuffer();

    res.setHeader('Content-Type', outMime);
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Output-Format', fmt);
    res.setHeader('X-Output-Width', String(newWidth));
    res.setHeader('X-Output-Height', String(newHeight));
    res.send(outputBuffer);
  } catch (err) {
    console.error('Upscale error:', err);
    res.status(500).json({ error: 'Image processing failed: ' + err.message });
  }
});

// ---- Start server ----
const server = app.listen(PORT, () => {
  console.log(`Meeting Notes server running on port ${PORT}`);
  console.log(`ffmpeg binary: ${FFMPEG}`);
  console.log(`Telegram: ${bot ? 'configured' : 'NOT configured'}`);
});

server.timeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;
