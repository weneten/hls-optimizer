const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const { URL } = require('url');

function getStreamTag(stream, tagName) {
  if (!stream || !stream.tags) return undefined;
  const targetLower = tagName.toLowerCase();
  for (const key of Object.keys(stream.tags)) {
    if (key.toLowerCase() === targetLower) {
      return stream.tags[key];
    }
  }
  return undefined;
}

function parseFrameRate(rFrameRate) {
  if (!rFrameRate) return 30;
  const parts = rFrameRate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return num / den;
  }
  const val = parseFloat(rFrameRate);
  return isNaN(val) ? 30 : val;
}

function getAV1ParamsForLabel(label) {
  const normLabel = (label || '').toLowerCase();
  const defaultPreset = process.env.HLS_AV1_PRESET || '8';
  const defaultCrf = process.env.HLS_AV1_CRF || '30';

  let preset = defaultPreset;
  let crf = defaultCrf;

  if (normLabel.includes('2160p')) {
    preset = process.env.HLS_AV1_PRESET_2160P || '6';
    crf = process.env.HLS_AV1_CRF_2160P || '32';
  } else if (normLabel.includes('1440p')) {
    preset = process.env.HLS_AV1_PRESET_1440P || '7';
    crf = process.env.HLS_AV1_CRF_1440P || '31';
  } else if (normLabel.includes('1080p')) {
    preset = process.env.HLS_AV1_PRESET_1080P || '8';
    crf = process.env.HLS_AV1_CRF_1080P || '30';
  } else if (normLabel.includes('720p')) {
    preset = process.env.HLS_AV1_PRESET_720P || '9';
    crf = process.env.HLS_AV1_CRF_720P || '29';
  } else if (normLabel.includes('480p')) {
    preset = process.env.HLS_AV1_PRESET_480P || '10';
    crf = process.env.HLS_AV1_CRF_480P || '28';
  } else if (normLabel.includes('360p')) {
    preset = process.env.HLS_AV1_PRESET_360P || '10';
    crf = process.env.HLS_AV1_CRF_360P || '27';
  }

  return { preset, crf };
}

function checkSvtAv1() {
  try {
    execSync('ffmpeg -encoders | grep -i svtav1', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function adjustVideoParams(label, codec, origBitrateKbps, origHeight, duration, basePreset, baseCrf) {
  let targetHeight = 1080;
  const labelMatch = (label || '').match(/(\d+)p/);
  if (labelMatch) {
    targetHeight = parseInt(labelMatch[1], 10);
  }

  let proportionalOrigBitrate = origBitrateKbps;
  if (origHeight && origHeight > 0 && origBitrateKbps) {
    proportionalOrigBitrate = origBitrateKbps * Math.pow(targetHeight / origHeight, 1.5);
  }

  let finalCrf = parseInt(baseCrf, 10);
  if (isNaN(finalCrf)) {
    finalCrf = codec === 'av1' ? 30 : 20;
  }

  // Determine standard expectation thresholds for resolution (H264 vs AV1)
  let standardBitrate = 4000;
  if (codec === 'h264') {
    if (targetHeight <= 360) standardBitrate = 700;
    else if (targetHeight <= 480) standardBitrate = 1200;
    else if (targetHeight <= 720) standardBitrate = 2200;
    else if (targetHeight <= 1080) standardBitrate = 4000;
    else if (targetHeight <= 1440) standardBitrate = 8000;
    else standardBitrate = 16000;
  } else if (codec === 'av1') {
    if (targetHeight <= 360) standardBitrate = 400;
    else if (targetHeight <= 480) standardBitrate = 700;
    else if (targetHeight <= 720) standardBitrate = 1300;
    else if (targetHeight <= 1080) standardBitrate = 2400;
    else if (targetHeight <= 1440) standardBitrate = 4800;
    else standardBitrate = 10000;
  }

  // If proportional original bitrate is lower than standard, increase CRF (less quality, lower filesize)
  if (proportionalOrigBitrate && proportionalOrigBitrate < standardBitrate) {
    const deficitRatio = proportionalOrigBitrate / standardBitrate;
    const maxIncrease = codec === 'av1' ? 12 : 8;
    const crfIncrease = Math.round(maxIncrease * (1 - deficitRatio));
    finalCrf += crfIncrease;
    
    const maxCrf = codec === 'av1' ? 42 : 30;
    if (finalCrf > maxCrf) finalCrf = maxCrf;
  }

  // Apply strict bitrate cap to guarantee output is smaller than original
  let maxrate = null;
  let bufsize = null;
  if (proportionalOrigBitrate) {
    const cappedBitrate = Math.max(codec === 'av1' ? 200 : 350, Math.round(proportionalOrigBitrate * 0.90));
    maxrate = `${cappedBitrate}k`;
    bufsize = `${cappedBitrate * 2}k`;
  }

  // Preset adjustment based on target resolution height and final CRF
  let finalPreset = basePreset;
  if (codec === 'av1') {
    // SVT-AV1 presets: 0 (slowest) to 13 (fastest)
    let minPreset = 6;
    if (targetHeight >= 2160) minPreset = 8;
    else if (targetHeight >= 1080) minPreset = 8;
    else if (targetHeight >= 720) minPreset = 7;
    
    let presetNum = parseInt(basePreset, 10);
    if (isNaN(presetNum)) {
      presetNum = minPreset;
    } else {
      presetNum = Math.max(presetNum, minPreset);
    }

    // Pair lower (slower) preset numbers with higher CRF to maintain detail on compressed streams,
    // and higher (faster) preset numbers with lower CRF where bits are plentiful.
    if (finalCrf >= 35) {
      presetNum = Math.max(6, presetNum - 2);
    } else if (finalCrf >= 31) {
      presetNum = Math.max(6, presetNum - 1);
    } else if (finalCrf <= 26) {
      presetNum = Math.min(11, presetNum + 1);
    }
    finalPreset = String(presetNum);
  } else if (codec === 'h264') {
    // x264 presets: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
    const presetsList = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
    let idx = presetsList.indexOf(basePreset);
    if (idx === -1) idx = 2; // default veryfast
    
    let maxAllowedIdx = 8;
    if (targetHeight >= 2160) maxAllowedIdx = 2; // veryfast
    else if (targetHeight >= 1080) maxAllowedIdx = 3; // faster
    else if (targetHeight >= 720) maxAllowedIdx = 4; // fast
    
    if (idx > maxAllowedIdx) {
      idx = maxAllowedIdx;
    }

    // Adjust based on CRF
    if (finalCrf >= 26) {
      idx = Math.min(maxAllowedIdx, idx + 1); // make it slower to maintain details
    } else if (finalCrf <= 18) {
      idx = Math.max(0, idx - 1); // make it faster
    }
    finalPreset = presetsList[idx];
  }

  return { crf: String(finalCrf), preset: finalPreset, maxrate, bufsize };
}


// Config and constants
const WORK_DIR = '/tmp/hls-worker';
const INPUT_FILE = path.join(WORK_DIR, 'input.mp4');
const OUTPUT_DIR = path.join(WORK_DIR, 'hls-output');
const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 1GB limit for zipped segments

// Standard API Request helper
function apiRequest(urlStr, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'github-storage-worker/1.0.0',
        ...headers,
      },
    };
    if (body) {
      if (Buffer.isBuffer(body)) {
        options.headers['Content-Length'] = body.length.toString();
      } else {
        const bodyStr = typeof body === 'object' ? JSON.stringify(body) : String(body);
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
        if (!options.headers['Content-Type']) {
          options.headers['Content-Type'] = 'application/json';
        }
        body = Buffer.from(bodyStr, 'utf8');
      }
    }
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, headers: res.headers, body: buffer });
        } else {
          reject(new Error(`Request to ${urlStr} failed with status ${res.statusCode}: ${buffer.toString('utf8')}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Redirect-following downloader that handles private GitHub Release assets
function downloadAsset(urlStr, token, destPath) {
  return new Promise((resolve, reject) => {
    function get(url) {
      const parsed = new URL(url);
      const headers = {
        'User-Agent': 'github-storage-worker/1.0.0',
      };
      // ONLY send Authorization & Accept headers if we are targeting GitHub endpoints.
      // S3/CDN endpoints will reject requests that mix signature query parameters with Auth headers.
      if (parsed.hostname.endsWith('github.com')) {
        headers['Authorization'] = `Bearer ${token}`;
        headers['Accept'] = 'application/octet-stream';
      }
      
      const req = https.get({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location;
          if (!loc) {
            reject(new Error('Redirected but found no Location header'));
            return;
          }
          get(loc); // follow redirect
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download asset, HTTP status: ${res.statusCode}`));
          return;
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });
      req.on('error', reject);
    }
    get(urlStr);
  });
}

// Upload a single file as a release asset (with retries on transient connection issues)
async function uploadAssetFile(uploadUrl, assetName, filePath, contentType, token) {
  const stat = fs.statSync(filePath);
  const baseUploadUrl = uploadUrl.split('{')[0];
  const uploadEndpoint = `${baseUploadUrl}?name=${encodeURIComponent(assetName)}`;
  const url = new URL(uploadEndpoint);
  
  // Parse owner, repo, and release ID from upload URL for potential deletion on retry
  let apiOwner = '';
  let apiRepo = '';
  let apiReleaseId = '';
  const match = baseUploadUrl.match(/\/repos\/([^\/]+)\/([^\/]+)\/releases\/(\d+)\/assets/);
  if (match) {
    apiOwner = match[1];
    apiRepo = match[2];
    apiReleaseId = match[3];
  }

  const maxAttempts = 3;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const timeoutMs = Math.max(
        15 * 60 * 1000, // 15 minutes minimum
        2 * 60 * 1000 * Math.ceil(stat.size / (100 * 1024 * 1024)) // 2 minutes per 100MB
      );
      return await new Promise((resolve, reject) => {
        const options = {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'github-storage-worker/1.0.0',
            'Content-Type': contentType,
            'Content-Length': stat.size.toString(),
            'Accept': 'application/vnd.github+json',
          },
          timeout: timeoutMs,
        };
        
        const req = https.request(options, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(buffer.toString('utf8')));
            } else {
              reject(new Error(`Status ${res.statusCode}: ${buffer.toString('utf8')}`));
            }
          });
        });
        
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('Upload request timed out'));
        });
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(req);
        fileStream.on('error', (err) => {
          req.destroy();
          reject(err);
        });
      });
    } catch (err) {
      console.warn(`Attempt ${attempt} to upload ${assetName} failed: ${err.message}`);
      if (attempt >= maxAttempts) {
        throw err;
      }

      // Check if duplicate asset needs to be deleted before retry (especially on 422 already_exists)
      if (apiOwner && apiRepo && apiReleaseId) {
        console.log(`Checking for existing asset ${assetName} to clean up...`);
        try {
          const listUrl = `https://api.github.com/repos/${apiOwner}/${apiRepo}/releases/${apiReleaseId}/assets`;
          const res = await apiRequest(listUrl, 'GET', {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'github-storage-worker/1.0.0',
          });
          const assets = JSON.parse(res.body.toString('utf8'));
          if (Array.isArray(assets)) {
            const existingAsset = assets.find(a => a.name === assetName);
            if (existingAsset) {
              console.log(`Found existing asset ${assetName} (ID: ${existingAsset.id}). Deleting to allow clean retry...`);
              const deleteUrl = `https://api.github.com/repos/${apiOwner}/${apiRepo}/releases/assets/${existingAsset.id}`;
              await apiRequest(deleteUrl, 'DELETE', {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'github-storage-worker/1.0.0',
              });
              console.log(`Successfully deleted duplicate asset ${assetName}`);
            }
          }
        } catch (cleanErr) {
          console.warn(`Warning: Failed to delete duplicate asset before retry: ${cleanErr.message}`);
        }
      }

      const backoffMs = attempt * 2000;
      console.log(`Retrying in ${backoffMs}ms...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

// Rewrite HLS manifest references to target the VPS virtual endpoints
function rewriteVariantPlaylist({ playlistText, fileId, label }) {
  const base = `/api/files/${encodeURIComponent(fileId)}/hls/${encodeURIComponent(label)}`;

  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      line = line.trim();
      if (!line) return line;
      if (line.startsWith('#EXT-X-MAP:')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => {
          const newUri = `${base}/segment/${encodeURIComponent(uri)}`;
          return `URI="${newUri}"`;
        });
      }
      if (line.startsWith('#')) return line;
      return `${base}/segment/${encodeURIComponent(line)}`;
    })
    .join('\n');
}

async function createNewRelease(owner, repo, fileId, label, partIndex, token) {
  const tagName = `hls-${fileId}-${label}-part${partIndex}-${Date.now()}`;
  const releaseName = `[HLS] File ${fileId} - ${label} (Part ${partIndex})`;
  const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases`;
  
  const res = await apiRequest(releaseUrl, 'POST', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  }, {
    tag_name: tagName,
    name: releaseName,
    body: `Rotated HLS release for file ID: ${fileId}\nVariant: ${label}\nPart: ${partIndex}`,
    draft: false,
    prerelease: true,
  });
  
  const data = JSON.parse(res.body.toString('utf8'));
  return {
    releaseId: data.id,
    uploadUrl: data.upload_url,
  };
}

function parseTimestamp(ts) {
  const parts = ts.trim().split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseFloat(parts[1]);
    return minutes * 60 + seconds;
  } else if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return 0;
}

function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds - hrs * 3600) / 60);
  const secs = seconds - hrs * 3600 - mins * 60;
  
  const hrsStr = String(hrs).padStart(2, '0');
  const minsStr = String(mins).padStart(2, '0');
  const secsStr = secs.toFixed(3).padStart(6, '0');
  
  return `${hrsStr}:${minsStr}:${secsStr}`;
}

function parseSegmentDurations(playlistText) {
  const durations = [];
  const lines = playlistText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const commaIdx = line.indexOf(',');
      const durStr = commaIdx !== -1 
        ? line.substring(8, commaIdx).trim() 
        : line.substring(8).trim();
      const dur = parseFloat(durStr);
      if (!isNaN(dur)) {
        durations.push(dur);
      }
    }
  }
  return durations;
}

function segmentVtt(vttContent, segmentDurations, videoDuration, outputDir, subIndex, startSegmentNumber) {
  const lines = vttContent.split(/\r?\n/);
  const cues = [];
  let i = 0;
  
  while (i < lines.length && lines[i].trim() !== '') {
    i++;
  }
  
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    
    let id = undefined;
    if (!lines[i].includes('-->')) {
      id = lines[i].trim();
      i++;
    }
    
    if (i < lines.length && lines[i].includes('-->')) {
      const tsLine = lines[i].trim();
      const parts = tsLine.split('-->');
      const startStr = parts[0].trim();
      const rest = parts[1].trim();
      
      const spaceIdx = rest.indexOf(' ');
      let endStr = rest;
      let settings = '';
      if (spaceIdx !== -1) {
        endStr = rest.substring(0, spaceIdx).trim();
        settings = rest.substring(spaceIdx).trim();
      }
      
      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);
      
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }
      
      const cleanedText = textLines.join('\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\{[^}]*\}/g, '');
      
      cues.push({
        id,
        start,
        end,
        settings,
        text: cleanedText
      });
    } else {
      i++;
    }
  }
  
  if (segmentDurations.length === 0) {
    const fallbackTime = 6;
    const totalDuration = videoDuration || (cues.length > 0 ? Math.max(...cues.map(c => c.end)) : 0);
    const fallbackNum = Math.ceil(totalDuration / fallbackTime);
    for (let segIdx = 0; segIdx < fallbackNum; segIdx++) {
      segmentDurations.push(segIdx === fallbackNum - 1 ? (totalDuration - segIdx * fallbackTime) : fallbackTime);
    }
  }
  
  const numSegments = segmentDurations.length;
  const segStarts = [];
  const segEnds = [];
  let accumTime = 0;
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    segStarts.push(accumTime);
    accumTime += segmentDurations[segIdx];
    segEnds.push(accumTime);
  }
  
  const segmentFiles = [];
  const maxTargetDuration = numSegments > 0 ? Math.max(...segmentDurations) : 6;
  
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    const segStart = segStarts[segIdx];
    const segEnd = segEnds[segIdx];
    const segmentTime = segmentDurations[segIdx];
    const mpegts = Math.round(segStart * 90000);
    
    let segmentContent = `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${mpegts}\n\n` +
      `STYLE\n` +
      `::cue {\n` +
      `  background: transparent;\n` +
      `  text-shadow: 0 0 2px black, 0 0 2px black, 0 0 2px black, 0 0 2px black;\n` +
      `}\n\n`;
    
    for (const cue of cues) {
      if (cue.start < segEnd && cue.end > segStart) {
        const relStart = Math.max(0, cue.start - segStart);
        const relEnd = Math.min(segmentTime, cue.end - segStart);
        if (relStart < relEnd) {
          if (cue.id) {
            segmentContent += `${cue.id}\n`;
          }
          segmentContent += `${formatTimestamp(relStart)} --> ${formatTimestamp(relEnd)}${cue.settings ? ' ' + cue.settings : ''}\n`;
          segmentContent += `${cue.text}\n\n`;
        }
      }
    }
    
    const finalSegIdx = startSegmentNumber !== undefined ? (startSegmentNumber + segIdx) : segIdx;
    const fileName = `subtitle_${subIndex}_${String(finalSegIdx).padStart(5, '0')}.vtt`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, segmentContent, 'utf8');
    segmentFiles.push(fileName);
  }
  
  const mediaSeq = startSegmentNumber !== undefined ? startSegmentNumber : 0;
  let playlistText = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.ceil(maxTargetDuration)}\n#EXT-X-MEDIA-SEQUENCE:${mediaSeq}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    const duration = segmentDurations[segIdx];
    const finalSegIdx = startSegmentNumber !== undefined ? (startSegmentNumber + segIdx) : segIdx;
    playlistText += `#EXTINF:${duration.toFixed(6)},\nsubtitle_${subIndex}_${String(finalSegIdx).padStart(5, '0')}.vtt\n`;
  }
  playlistText += '#EXT-X-ENDLIST\n';
  
  return playlistText;
}

async function main() {
  const payloadStr = process.env.EVENT_PAYLOAD;
  const token = process.env.PRIVATE_REPO_TOKEN;

  if (!payloadStr) {
    console.error('Error: EVENT_PAYLOAD environment variable is missing.');
    process.exit(1);
  }
  if (!token) {
    console.error('Error: PRIVATE_REPO_TOKEN environment variable is missing.');
    process.exit(1);
  }

  const payload = JSON.parse(payloadStr);
  const {
    file_id,
    user_id,
    source_release_id,
    release_id,
    owner,
    repo,
    label,
    kind,
    target_height,
    vps,
    vps_callback_url: flat_vps_callback_url,
    vps_callback_token: flat_vps_callback_token
  } = payload;

  const vps_callback_url = vps ? vps.callback_url : flat_vps_callback_url;
  const vps_callback_token = vps ? vps.callback_token : flat_vps_callback_token;
  const hls_preset = (vps && vps.preset) ? vps.preset : 'veryfast';
  const hls_crf = (vps && vps.crf !== undefined) ? String(vps.crf) : '20';
  const hls_maxrate = (vps && vps.maxrate) ? String(vps.maxrate) : undefined;
  const hls_bufsize = (vps && vps.bufsize) ? String(vps.bufsize) : undefined;
  const hls_profile = (vps && vps.profile) ? String(vps.profile) : undefined;
  const hls_level = (vps && vps.level) ? String(vps.level) : undefined;
  const hls_audio_bitrate = (vps && vps.audio_bitrate !== undefined) ? parseInt(vps.audio_bitrate, 10) : 192;
  const extract_subtitles = (vps && vps.extract_subtitles !== undefined) ? !!vps.extract_subtitles : true;
  const extract_audio = (vps && vps.extract_audio !== undefined) ? !!vps.extract_audio : true;
  const subtitle_metadata = vps ? vps.subtitle_metadata : undefined;
  
  const slice_index = (vps && vps.slice_index !== undefined) ? parseInt(vps.slice_index, 10) : undefined;
  const total_slices = (vps && vps.total_slices !== undefined) ? parseInt(vps.total_slices, 10) : undefined;
  const slice_start = (vps && vps.slice_start !== undefined) ? parseFloat(vps.slice_start) : undefined;
  const slice_duration = (vps && vps.slice_duration !== undefined) ? parseFloat(vps.slice_duration) : undefined;
  const start_segment_number = (vps && vps.start_segment_number !== undefined) ? parseInt(vps.start_segment_number, 10) : undefined;

  // Resolve Codecs list
  let codecs = ['h264'];
  if (vps && Array.isArray(vps.codecs)) {
    codecs = vps.codecs;
  } else if (process.env.HLS_CODECS) {
    codecs = process.env.HLS_CODECS.split(',').map(c => c.trim()).filter(Boolean);
  }

  // Resolve AV1 settings
  const av1ParamsFromEnv = getAV1ParamsForLabel(label);
  const hls_av1_preset = (vps && vps.av1_preset !== undefined) ? String(vps.av1_preset) : av1ParamsFromEnv.preset;
  const hls_av1_crf = (vps && vps.av1_crf !== undefined) ? String(vps.av1_crf) : av1ParamsFromEnv.crf;

  console.log(`Starting HLS Optimization Job for file: ${file_id} (Release: ${release_id}, Label: ${label}, Kind: ${kind}, Codecs: [${codecs.join(', ')}], Preset: ${hls_preset}, CRF: ${hls_crf}, AV1 Preset: ${hls_av1_preset}, AV1 CRF: ${hls_av1_crf}, Maxrate: ${hls_maxrate}, Bufsize: ${hls_bufsize}, Audio Bitrate: ${hls_audio_bitrate}k, extract_subtitles=${extract_subtitles}, extract_audio=${extract_audio})`);

  // 1. Prepare directories
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 2. Fetch Source Release Assets info
  const sourceReleaseId = source_release_id || release_id; // Fallback if source_release_id is not provided
  const sourceReleaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${sourceReleaseId}`;
  console.log(`Fetching source release info from: ${sourceReleaseUrl}`);
  const sourceReleaseRes = await apiRequest(sourceReleaseUrl, 'GET', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  });
  const sourceReleaseInfo = JSON.parse(sourceReleaseRes.body.toString('utf8'));

  // 2b. Fetch Target Release info for uploads
  const targetReleaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${release_id}`;
  console.log(`Fetching target release info from: ${targetReleaseUrl}`);
  const targetReleaseRes = await apiRequest(targetReleaseUrl, 'GET', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
  });
  const targetReleaseInfo = JSON.parse(targetReleaseRes.body.toString('utf8'));
  const uploadUrl = targetReleaseInfo.upload_url;

  // Release rotation variables for handling large numbers of assets (>750)
  let currentReleaseId = release_id;
  let currentUploadUrl = uploadUrl;
  let assetsUploadedInCurrentRelease = 0;
  const githubReleaseIds = [release_id];

  async function uploadAssetWithRotation(assetName, filePath, contentType) {
    if (assetsUploadedInCurrentRelease >= 750) {
      console.log(`Current release ${currentReleaseId} has reached the asset limit (${assetsUploadedInCurrentRelease} assets). Creating a new release...`);
      const newReleaseCount = githubReleaseIds.length + 1;
      const newRelease = await createNewRelease(owner, repo, file_id, label, newReleaseCount, token);
      currentReleaseId = newRelease.releaseId;
      currentUploadUrl = newRelease.uploadUrl;
      githubReleaseIds.push(currentReleaseId);
      assetsUploadedInCurrentRelease = 0;
    }
    
    const res = await uploadAssetFile(currentUploadUrl, assetName, filePath, contentType, token);
    assetsUploadedInCurrentRelease++;
    return res;
  }

  // Filter out and sort the split parts from the source release
  let partAssets = sourceReleaseInfo.assets
    .filter(a => a.name.includes('.part'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (partAssets.length === 0) {
    // Fallback for non-chunked source video uploads (e.g., single mp4/mkv files)
    partAssets = sourceReleaseInfo.assets
      .filter(a => !a.name.endsWith('.zip') && !a.name.endsWith('.m3u8') && !a.name.endsWith('.vtt') && !a.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (partAssets.length === 0) {
    console.error(`Error: No source files found in the source release (${sourceReleaseId}).`);
    process.exit(1);
  }

  // 3. Download the part files
  console.log(`Downloading ${partAssets.length} part files...`);
  const localParts = [];
  for (const asset of partAssets) {
    const partPath = path.join(WORK_DIR, asset.name);
    console.log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
    await downloadAsset(asset.url, token, partPath);
    localParts.push(partPath);
  }

  // 4. Combine the parts into a single video file
  console.log('Combining part files...');
  const writeStream = fs.createWriteStream(INPUT_FILE);
  for (const partPath of localParts) {
    const data = fs.readFileSync(partPath);
    writeStream.write(data);
    fs.unlinkSync(partPath); // delete part to save disk space
  }
  await new Promise(resolve => writeStream.end(resolve));
  console.log(`Combined video ready at ${INPUT_FILE} (${(fs.statSync(INPUT_FILE).size / 1024 / 1024).toFixed(1)} MB).`);

  // 5. Probe video stream properties
  console.log('Probing video stream properties...');
  const probeCmd = `ffprobe -v error -show_entries "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,channels,r_frame_rate,bit_rate:stream_tags" -of json "${INPUT_FILE}"`;
  const probeData = JSON.parse(execSync(probeCmd, { maxBuffer: 100 * 1024 * 1024 }).toString());

  const videoStream = probeData.streams.find(s => s.codec_type === 'video');
  if (!videoStream) {
    console.error('Error: No video stream found in the source file.');
    process.exit(1);
  }
  const inferredWidth = videoStream.width || null;
  const inferredHeight = videoStream.height || null;
  const inferredCodec = kind === 'original' ? (videoStream.codec_name || 'copy') : 'h264';

  const format = probeData.format || {};
  const duration = format.duration ? parseFloat(format.duration) : (vps && vps.duration ? parseFloat(vps.duration) : 0);
  const fileSize = format.size ? parseInt(format.size, 10) : 0;
  
  let origBitrateKbps = vps && vps.source_bitrate_kbps ? parseInt(vps.source_bitrate_kbps, 10) : null;
  if (!origBitrateKbps) {
    if (format.bit_rate) {
      origBitrateKbps = Math.round(parseInt(format.bit_rate, 10) / 1000);
    } else if (duration > 0 && fileSize > 0) {
      origBitrateKbps = Math.round((fileSize * 8) / duration / 1000);
    }
  }
  const origHeight = inferredHeight || (vps && vps.source_height ? parseInt(vps.source_height, 10) : null);

  let outputWidth = inferredWidth;
  let outputHeight = inferredHeight;
  if (kind === 'compressed' && inferredWidth && inferredHeight) {
    const targetHeight = target_height || 1080;
    outputHeight = Math.min(targetHeight, inferredHeight);
    outputWidth = Math.round((outputHeight * inferredWidth) / inferredHeight / 2) * 2;
  }

  const audioStream = probeData.streams.find(s => s.codec_type === 'audio');
  const hasAacAudio = audioStream && audioStream.codec_name?.toLowerCase() === 'aac';

  // Find text subtitle streams that FFmpeg can parse to webvtt
  const textSubtitleCodecs = new Set(['ass', 'ssa', 'srt', 'subrip', 'webvtt', 'mov_text', 'text']);
  const subtitleStreams = [];
  const audioStreams = [];

  function getLanguageName(langCode) {
    if (!langCode || langCode === 'und') return undefined;
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'language' });
      const name = dn.of(langCode);
      if (name && name !== langCode && name !== 'root') return name;
    } catch (e) {
      // Ignore
    }
    return undefined;
  }

  // Probe audio + subtitle streams for every variant so we know what is present.
  // Audio + subtitle assets are only SEGMENTED + UPLOADED by the 'original' variant
  // (stored once, shared by all variants via the master playlist). Compressed variants
  // only need the metadata so they can flag the default audio in their callback.
  probeData.streams.forEach(s => {
    if (s.codec_type === 'subtitle') {
      const codec = s.codec_name?.toLowerCase();
      if (codec && textSubtitleCodecs.has(codec)) {
        const lang = getStreamTag(s, 'language');
        // If subtitle_metadata is provided from the payload (VPS-probed from original file),
        // use it to get the correct title. The recombined file may lose subtitle name tags.
        let title = getStreamTag(s, 'title') || getStreamTag(s, 'name') || getLanguageName(lang);
        if (subtitle_metadata && Array.isArray(subtitle_metadata)) {
          const match = subtitle_metadata.find(m => m.streamIndex === s.index);
          if (match && match.title) {
            title = match.title;
          }
        }
        subtitleStreams.push({
          index: s.index,
          codec,
          language: lang,
          title
        });
      }
    } else if (s.codec_type === 'audio') {
      const lang = getStreamTag(s, 'language');
      const bitRate = s.bit_rate ? parseInt(s.bit_rate, 10) : null;
      audioStreams.push({
        index: s.index,
        codec: s.codec_name?.toLowerCase(),
        language: lang,
        channels: s.channels || 2,
        bitRate: isNaN(bitRate) ? null : bitRate,
        title: getStreamTag(s, 'title') || getStreamTag(s, 'name') || getLanguageName(lang)
      });
    }
  });

  // 6. Segment Subtitles first (always process if present, for all variant kinds)
  const subtitlePlaylists = [];
  if (extract_subtitles && subtitleStreams.length > 0) {
    console.log(`Processing ${subtitleStreams.length} subtitle streams...`);
    for (const sub of subtitleStreams) {
      console.log(`Converting subtitle stream #${sub.index} (${sub.codec})...`);
      const subPlaylistPath = path.join(OUTPUT_DIR, `subtitle_${sub.index}.m3u8`);
      const fullVttPath = path.join(OUTPUT_DIR, `subtitle_${sub.index}.vtt`);
      
      const videoDuration = (probeData.format && probeData.format.duration) ? parseFloat(probeData.format.duration) : null;
      const videoDurationVal = slice_duration !== undefined ? slice_duration : (videoDuration || 0);

      // Step 1: Extract subtitle stream slice to a VTT file
      const extractCmd = `ffmpeg -y ${slice_start !== undefined ? `-ss ${slice_start} ` : ''}-i "${INPUT_FILE}" ${videoDurationVal ? `-t ${videoDurationVal} ` : ''}-vn -an -map 0:${sub.index} -c:s webvtt "${fullVttPath}"`;
      console.log(`Executing Subtitle Extract command: ${extractCmd}`);
      
      try {
        execSync(extractCmd, { stdio: 'inherit' });
        
        if (fs.existsSync(fullVttPath)) {
          const fullContent = fs.readFileSync(fullVttPath, 'utf8');
          
          const segmentDurations = [];
          const fallbackTime = 6;
          const fallbackNum = Math.ceil(videoDurationVal / fallbackTime);
          for (let segIdx = 0; segIdx < fallbackNum; segIdx++) {
            segmentDurations.push(segIdx === fallbackNum - 1 ? (videoDurationVal - segIdx * fallbackTime) : fallbackTime);
          }
          
          const playlistText = segmentVtt(fullContent, segmentDurations, videoDurationVal, OUTPUT_DIR, sub.index, start_segment_number);
          fs.writeFileSync(subPlaylistPath, playlistText);
          
          subtitlePlaylists.push({
            streamIndex: sub.index,
            language: sub.language,
            title: sub.title,
            playlistText: playlistText
          });
          
          fs.unlinkSync(fullVttPath);
          const segCount = fs.readdirSync(OUTPUT_DIR)
            .filter(name => name.startsWith(`subtitle_${sub.index}_`) && name.endsWith('.vtt')).length;
          console.log(`Subtitle stream #${sub.index} converted successfully with ${segCount} segments`);
        } else {
          console.warn(`Warning: Extracted VTT file not found for stream #${sub.index}`);
        }
      } catch (err) {
        console.warn(`Warning: Failed to convert subtitle stream #${sub.index}. Skipping.`);
        if (fs.existsSync(fullVttPath)) {
          try { fs.unlinkSync(fullVttPath); } catch (e) {}
        }
      }
    }
  }

  // 7. Segment Audio next (always process if present, for all variant kinds)
  const audioPlaylists = [];
  if (extract_audio && audioStreams.length > 0) {
    console.log(`Processing audio tracks (found ${audioStreams.length} total)...`);
    for (const aud of audioStreams) {
      console.log(`Converting audio stream #${aud.index} (${aud.codec})...`);
      const audPlaylistPath = path.join(OUTPUT_DIR, `audio_${aud.index}.m3u8`);
      const audSegmentPattern = path.join(OUTPUT_DIR, `audio_${aud.index}_%05d.m4s`);
      const audInitName = slice_index !== undefined ? `audio_${aud.index}_init_part${slice_index}.mp4` : `audio_${aud.index}_init.mp4`;
      
      let targetAudioBitrate;
      if (aud.bitRate) {
        const origAudioBitrateKbps = Math.round(aud.bitRate / 1000);
        if (origAudioBitrateKbps <= hls_audio_bitrate) {
          targetAudioBitrate = origAudioBitrateKbps;
        } else {
          targetAudioBitrate = Math.min(origAudioBitrateKbps, 320);
        }
      } else {
        const channels = aud.channels || 2;
        targetAudioBitrate = Math.min(320, Math.max(96, Math.round((channels / 2) * hls_audio_bitrate)));
      }
      let audFfmpegCmd = `ffmpeg -y `;
      if (slice_start !== undefined) {
        audFfmpegCmd += `-ss ${slice_start} `;
      }
      audFfmpegCmd += `-i "${INPUT_FILE}" `;
      if (slice_duration !== undefined) {
        audFfmpegCmd += `-t ${slice_duration} `;
      }
      audFfmpegCmd += `-vn -map 0:${aud.index} -c:a aac -b:a ${targetAudioBitrate}k -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_type fmp4 -hls_segment_filename "${audSegmentPattern}" -hls_fmp4_init_filename "${audInitName}" `;
      if (start_segment_number !== undefined) {
        audFfmpegCmd += `-start_number ${start_segment_number} `;
      }
      audFfmpegCmd += `"${audPlaylistPath}"`;
      console.log(`Executing Audio FFmpeg command: ${audFfmpegCmd}`);
      
      try {
        execSync(audFfmpegCmd, { stdio: 'inherit' });
        const rawAudPlaylist = fs.readFileSync(audPlaylistPath, 'utf8');
        audioPlaylists.push({
          streamIndex: aud.index,
          language: aud.language,
          title: aud.title,
          playlistText: rawAudPlaylist
        });
      } catch (err) {
        console.warn(`Warning: Failed to convert audio stream #${aud.index}. Skipping.`);
      }
    }
  }

  // 8. Run sequential codec segmentation jobs
  const codecResults = [];
  const skippedCodecs = [];

  let resolvedCodecs = [];
  if (kind === 'original') {
    resolvedCodecs = [inferredCodec];
  } else {
    resolvedCodecs = codecs;
  }

  async function processCodecJob(codec) {
    console.log(`Running FFmpeg segmenting on video for codec: ${codec}...`);
    
    if (codec === 'av1') {
      const svtav1Available = checkSvtAv1();
      if (!svtav1Available) {
        console.log(`AV1 encoder (libsvtav1) not available in this ffmpeg build, skipping AV1 rendition`);
        throw new Error('libsvtav1 encoder not available');
      }
    }

    const useCodecSuffix = resolvedCodecs.length > 1;
    const playlistName = useCodecSuffix ? `variant_${codec}.m3u8` : 'variant.m3u8';
    const segmentPattern = useCodecSuffix ? `seg_${codec}_%05d.m4s` : 'seg%05d.m4s';
    const initName = useCodecSuffix ? (slice_index !== undefined ? `init_${codec}_part${slice_index}.mp4` : `init_${codec}.mp4`) : (slice_index !== undefined ? `init_part${slice_index}.mp4` : 'init.mp4');

    const playlistPath = path.join(OUTPUT_DIR, playlistName);
    const segmentPatternPath = path.join(OUTPUT_DIR, segmentPattern);

    const ffmpegArgs = [
      'ffmpeg',
      '-y',
    ];
    if (slice_start !== undefined) {
      ffmpegArgs.push('-ss', String(slice_start));
    }
    ffmpegArgs.push('-i', `"${INPUT_FILE}"`);
    if (slice_duration !== undefined) {
      ffmpegArgs.push('-t', String(slice_duration));
    }
    ffmpegArgs.push(
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4',
      '-hls_segment_filename', `"${segmentPatternPath}"`,
      '-hls_fmp4_init_filename', `"${initName}"`,
      '-hls_flags', 'independent_segments'
    );
    if (start_segment_number !== undefined) {
      ffmpegArgs.push('-start_number', String(start_segment_number));
    }
    ffmpegArgs.push('-map', '0:v');

    let resolvedOutputWidth = inferredWidth;
    let resolvedOutputHeight = inferredHeight;

    if (kind === 'original') {
      ffmpegArgs.push('-c:v', 'copy');
    } else {
      // Compressed variant
      const tHeight = target_height || 1080;
      resolvedOutputHeight = Math.min(tHeight, inferredHeight);
      resolvedOutputWidth = Math.round((resolvedOutputHeight * inferredWidth) / inferredHeight / 2) * 2;

      // Adjust parameters dynamically based on video profiles
      const dynamicParams = adjustVideoParams(
        label,
        codec,
        origBitrateKbps,
        origHeight,
        duration,
        codec === 'av1' ? hls_av1_preset : hls_preset,
        codec === 'av1' ? hls_av1_crf : hls_crf
      );
      console.log(`Dynamic params adjusted for ${codec}: CRF=${dynamicParams.crf}, Preset=${dynamicParams.preset}, Maxrate=${dynamicParams.maxrate || 'N/A'}, Bufsize=${dynamicParams.bufsize || 'N/A'}`);

      if (codec === 'h264') {
        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', dynamicParams.preset,
          '-crf', dynamicParams.crf
        );
        const activeMaxrate = dynamicParams.maxrate || hls_maxrate;
        const activeBufsize = dynamicParams.bufsize || hls_bufsize;
        if (activeMaxrate) ffmpegArgs.push('-maxrate', activeMaxrate);
        if (activeBufsize) ffmpegArgs.push('-bufsize', activeBufsize);
        if (hls_profile) ffmpegArgs.push('-profile:v', hls_profile);
        if (hls_level) ffmpegArgs.push('-level', hls_level);
        ffmpegArgs.push(
          '-vf', `"scale='trunc(oh*a/2)*2':'trunc(min(${tHeight},ih)/2)*2'"`,
          '-force_key_frames', '"expr:gte(t,n_forced*6)"',
          '-sc_threshold', '0',
          '-flags', '+cgop'
        );
      } else if (codec === 'av1') {
        let fps = 30; // default fallback
        try {
          if (videoStream && videoStream.r_frame_rate) {
            fps = parseFrameRate(videoStream.r_frame_rate);
          }
        } catch (e) {
          console.warn('Failed parsing r_frame_rate:', e);
        }
        const gop = Math.round(fps * 6);

        ffmpegArgs.push(
          '-c:v', 'libsvtav1',
          '-preset', dynamicParams.preset,
          '-crf', dynamicParams.crf,
          '-svtav1-params', 'tune=0',
          '-pix_fmt', 'yuv420p',
          '-g', String(gop)
        );
        if (dynamicParams.maxrate) {
          ffmpegArgs.push('-maxrate', dynamicParams.maxrate);
        }
        if (dynamicParams.bufsize) {
          ffmpegArgs.push('-bufsize', dynamicParams.bufsize);
        }
        ffmpegArgs.push(
          '-vf', `"scale='trunc(oh*a/2)*2':'trunc(min(${tHeight},ih)/2)*2'"`
        );
      } else {
        throw new Error(`Unsupported codec: ${codec}`);
      }
    }

    ffmpegArgs.push(`"${playlistPath}"`);
    const ffmpegCmd = ffmpegArgs.flat().join(' ');
    console.log(`Executing FFmpeg command: ${ffmpegCmd}`);
    execSync(ffmpegCmd, { stdio: 'inherit' });

    // Group segments and package ZIPs
    console.log(`Grouping segments and packaging ZIPs for ${codec}...`);
    const videoSegRegex = useCodecSuffix ? new RegExp(`^seg_${codec}_(\\d{5})\\.m4s$`) : /^seg(\d{5})\.m4s$/;
    const videoInitRegex = useCodecSuffix ? new RegExp(`^init_${codec}\\.mp4$`) : /^init\.mp4$/;
    const subtitleSegRegex = /^subtitle_\d+_(\d{5})\.vtt$/;
    const audioSegRegex = /^audio_\d+_(\d{5})\.m4s$/;
    const audioInitRegex = /^audio_\d+_init\.mp4$/;

    const filesToZip = fs.readdirSync(OUTPUT_DIR)
      .filter(name => {
        if (videoSegRegex.test(name) || videoInitRegex.test(name)) return true;
        if (subtitleSegRegex.test(name) || audioSegRegex.test(name) || audioInitRegex.test(name)) return true;
        return false;
      })
      .map(name => {
        const fullPath = path.join(OUTPUT_DIR, name);
        const size = fs.statSync(fullPath).size;
        
        let segmentIndex = null;
        const segMatch = name.match(videoSegRegex);
        if (segMatch) {
          segmentIndex = parseInt(segMatch[1], 10);
        } else {
          const subMatch = name.match(subtitleSegRegex);
          if (subMatch) {
            segmentIndex = parseInt(subMatch[1], 10);
          } else {
            const audMatch = name.match(audioSegRegex);
            if (audMatch) {
              segmentIndex = parseInt(audMatch[1], 10);
            }
          }
        }
        return { name, fullPath, size, segmentIndex };
      });

    filesToZip.sort((a, b) => {
      const isInitA = a.name.includes('init');
      const isInitB = b.name.includes('init');
      if (isInitA && !isInitB) return -1;
      if (!isInitA && isInitB) return 1;
      
      const idxA = a.segmentIndex !== null ? a.segmentIndex : -1;
      const idxB = b.segmentIndex !== null ? b.segmentIndex : -1;
      if (idxA !== idxB) {
        return idxA - idxB;
      }
      return a.name.localeCompare(b.name);
    });

    const completedZipsForCodec = [];
    let currentZipSize = 0;
    let currentZipIndex = slice_index !== undefined ? slice_index : 0;
    let pendingFiles = [];
    let segmentStart = null;
    let segmentEnd = null;

    async function uploadZipBatch() {
      if (pendingFiles.length === 0) return;
      
      const zipName = useCodecSuffix 
        ? `segments-${label}-${codec}-part${currentZipIndex.toString().padStart(4, '0')}.zip`
        : `segments-${label}-part${currentZipIndex.toString().padStart(4, '0')}.zip`;
      const zipPath = path.join(WORK_DIR, zipName);
      
      console.log(`Packaging ZIP ${zipName} with ${pendingFiles.length} segments...`);
      const fileArgs = pendingFiles.map(f => `"${f.fullPath}"`).join(' ');
      execSync(`zip -0 -j "${zipPath}" ${fileArgs}`, { stdio: 'ignore' });
      
      const zipSize = fs.statSync(zipPath).size;
      console.log(`Uploading ${zipName} (${(zipSize / 1024 / 1024).toFixed(1)} MB)...`);
      const uploadRes = await uploadAssetWithRotation(zipName, zipPath, 'application/zip');
      
      completedZipsForCodec.push({
        zipIndex: currentZipIndex,
        assetId: uploadRes.id,
        url: uploadRes.browser_download_url,
        zipSize,
        segmentStart,
        segmentEnd
      });
      
      fs.unlinkSync(zipPath);
      for (const f of pendingFiles) {
        try { fs.unlinkSync(f.fullPath); } catch (e) {}
      }
      
      currentZipIndex++;
      currentZipSize = 0;
      pendingFiles = [];
      segmentStart = null;
      segmentEnd = null;
    }

    for (const file of filesToZip) {
      if (file.segmentIndex !== null) {
        if (segmentStart === null || file.segmentIndex < segmentStart) segmentStart = file.segmentIndex;
        if (segmentEnd === null || file.segmentIndex > segmentEnd) segmentEnd = file.segmentIndex;
      }
      
      pendingFiles.push(file);
      currentZipSize += file.size;
      
      if (currentZipSize >= MAX_ZIP_BYTES) {
        await uploadZipBatch();
      }
    }
    await uploadZipBatch();

    // Compute measuredBandwidth
    let measuredBandwidth = 0;
    const videoDuration = (probeData.format && probeData.format.duration) ? parseFloat(probeData.format.duration) : null;
    const durForBandwidth = slice_duration !== undefined ? slice_duration : videoDuration;
    if (durForBandwidth && durForBandwidth > 0) {
      const totalBytes = filesToZip.reduce((acc, f) => acc + f.size, 0);
      measuredBandwidth = Math.round((totalBytes * 8) / durForBandwidth);
    }

    // Rewrite and Upload Manifests
    console.log(`Rewriting manifest for ${codec} to absolute paths...`);
    const mainPlaylistText = fs.readFileSync(playlistPath, 'utf8');
    const dbLabel = useCodecSuffix ? `${label}_${codec}` : label;
    const rewrittenMainPlaylist = rewriteVariantPlaylist({
      playlistText: mainPlaylistText,
      fileId: file_id,
      label: dbLabel
    });

    const playlistAssetName = useCodecSuffix ? `playlist_${codec}.m3u8` : 'playlist.m3u8';
    const mainPlaylistTmpPath = path.join(WORK_DIR, playlistAssetName);
    fs.writeFileSync(mainPlaylistTmpPath, rewrittenMainPlaylist);
    console.log(`Uploading rewritten main HLS playlist as ${playlistAssetName}...`);
    await uploadAssetWithRotation(playlistAssetName, mainPlaylistTmpPath, 'application/vnd.apple.mpegurl');
    fs.unlinkSync(mainPlaylistTmpPath);

    return {
      codec,
      outputWidth: resolvedOutputWidth,
      outputHeight: resolvedOutputHeight,
      measuredBandwidth,
      rewrittenPlaylist: rewrittenMainPlaylist,
      completedZips: completedZipsForCodec
    };
  }

  for (const codec of resolvedCodecs) {
    try {
      const result = await processCodecJob(codec);
      if (result) {
        codecResults.push(result);
      }
    } catch (err) {
      console.warn(`Warning: Failed to process job for codec ${codec}:`, err);
      skippedCodecs.push({ codec, reason: err.message || 'Unknown error' });
    }
  }

  // Fallback to H.264 if no renditions succeeded
  if (codecResults.length === 0) {
    console.log('No codecs were successfully processed. Attempting H.264 fallback...');
    try {
      const result = await processCodecJob('h264');
      if (result) {
        codecResults.push(result);
        const index = skippedCodecs.findIndex(s => s.codec === 'h264');
        if (index !== -1) {
          skippedCodecs.splice(index, 1);
        }
      }
    } catch (err) {
      console.error('Fatal Error: Fallback to H.264 also failed:', err);
      skippedCodecs.push({ codec: 'h264', reason: err.message || 'Unknown error during fallback' });
    }
  }

  if (codecResults.length === 0) {
    console.error('Fatal Error: No codecs could be processed and H.264 fallback failed.');
    process.exit(1);
  }

  // Delete input file to release space
  fs.unlinkSync(INPUT_FILE);

  // 9. Rewrite and Upload subtitle/audio manifests
  console.log('Rewriting and uploading subtitle/audio manifests to absolute paths...');
  const firstSuccess = codecResults[0];
  const useCodecSuffix = resolvedCodecs.length > 1;
  const activeLabel = useCodecSuffix ? `${label}_${firstSuccess.codec}` : label;

  const rewrittenSubtitlePlaylists = [];
  for (const subPlaylist of subtitlePlaylists) {
    const rewrittenText = rewriteVariantPlaylist({
      playlistText: subPlaylist.playlistText,
      fileId: file_id,
      label: activeLabel
    });
    
    const subFileName = `subtitle_${subPlaylist.streamIndex}.m3u8`;
    const subPlaylistTmpPath = path.join(WORK_DIR, subFileName);
    fs.writeFileSync(subPlaylistTmpPath, rewrittenText);
    
    console.log(`Uploading rewritten subtitle playlist #${subPlaylist.streamIndex} as ${subFileName}...`);
    await uploadAssetWithRotation(subFileName, subPlaylistTmpPath, 'application/vnd.apple.mpegurl');
    fs.unlinkSync(subPlaylistTmpPath);
    
    rewrittenSubtitlePlaylists.push({
      streamIndex: subPlaylist.streamIndex,
      language: subPlaylist.language,
      title: subPlaylist.title,
      playlistText: rewrittenText
    });
  }

  const rewrittenAudioPlaylists = [];
  for (const audPlaylist of audioPlaylists) {
    const rewrittenText = rewriteVariantPlaylist({
      playlistText: audPlaylist.playlistText,
      fileId: file_id,
      label: activeLabel
    });
    
    const audFileName = `audio_${audPlaylist.streamIndex}.m3u8`;
    const audPlaylistTmpPath = path.join(WORK_DIR, audFileName);
    fs.writeFileSync(audPlaylistTmpPath, rewrittenText);
    
    console.log(`Uploading rewritten audio playlist #${audPlaylist.streamIndex} as ${audFileName}...`);
    await uploadAssetWithRotation(audFileName, audPlaylistTmpPath, 'application/vnd.apple.mpegurl');
    fs.unlinkSync(audPlaylistTmpPath);
    
    rewrittenAudioPlaylists.push({
      streamIndex: audPlaylist.streamIndex,
      language: audPlaylist.language,
      title: audPlaylist.title,
      playlistText: rewrittenText
    });
  }

  // 10. Callback to VPS to notify completeness
  console.log(`Sending success callback to VPS at: ${vps_callback_url}`);

  const audiosForCallback = audioStreams.map((aud, i) => ({
    streamIndex: aud.index,
    language: aud.language,
    title: aud.title,
    isDefault: i === 0
  }));

  const renditionsForCallback = codecResults.map(r => ({
    codec: r.codec,
    width: r.outputWidth,
    height: r.outputHeight,
    measuredBandwidth: r.measuredBandwidth,
    playlistText: r.rewrittenPlaylist,
    completedZips: r.completedZips
  }));

  const callbackBody = {
    fileId: file_id,
    userId: user_id,
    label,
    kind,
    renditions: renditionsForCallback,
    skippedCodecs,
    githubReleaseId: release_id,
    githubReleaseIds,
    subtitles: rewrittenSubtitlePlaylists,
    audios: audiosForCallback,
    token: vps_callback_token,
    ...(slice_index !== undefined ? { sliceIndex: slice_index, totalSlices: total_slices } : {})
  };

  await apiRequest(vps_callback_url, 'POST', {
    'Content-Type': 'application/json'
  }, callbackBody);

  console.log('HLS Optimization Job successfully completed and logged on VPS!');
}

main().catch(err => {
  console.error('Fatal Error during HLS Optimization run:', err);
  process.exit(1);
});
