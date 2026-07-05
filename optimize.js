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

// Upload a single file as a release asset
async function uploadAssetFile(uploadUrl, assetName, filePath, contentType, token) {
  const stat = fs.statSync(filePath);
  const baseUploadUrl = uploadUrl.split('{')[0];
  const uploadEndpoint = `${baseUploadUrl}?name=${encodeURIComponent(assetName)}`;
  const url = new URL(uploadEndpoint);
  
  return new Promise((resolve, reject) => {
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
    };
    
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(buffer.toString('utf8')));
        } else {
          reject(new Error(`Failed to upload asset ${assetName}, status ${res.statusCode}: ${buffer.toString('utf8')}`));
        }
      });
    });
    
    req.on('error', reject);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(req);
    fileStream.on('error', (err) => {
      req.destroy();
      reject(err);
    });
  });
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

  console.log(`Starting HLS Optimization Job for file: ${file_id} (Release: ${release_id}, Label: ${label}, Kind: ${kind}, Preset: ${hls_preset}, CRF: ${hls_crf})`);

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
  const probeCmd = `ffprobe -v error -show_entries "format=duration:stream=index,codec_type,codec_name,width,height:stream_tags" -of json "${INPUT_FILE}"`;
  const probeData = JSON.parse(execSync(probeCmd, { maxBuffer: 100 * 1024 * 1024 }).toString());

  const videoStream = probeData.streams.find(s => s.codec_type === 'video');
  if (!videoStream) {
    console.error('Error: No video stream found in the source file.');
    process.exit(1);
  }
  const inferredWidth = videoStream.width || null;
  const inferredHeight = videoStream.height || null;
  const inferredCodec = kind === 'original' ? (videoStream.codec_name || 'copy') : 'h264';

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
        subtitleStreams.push({
          index: s.index,
          codec,
          language: lang,
          title: getStreamTag(s, 'title') || getStreamTag(s, 'name') || getLanguageName(lang)
        });
      }
    } else if (s.codec_type === 'audio') {
      const lang = getStreamTag(s, 'language');
      audioStreams.push({
        index: s.index,
        codec: s.codec_name?.toLowerCase(),
        language: lang,
        title: getStreamTag(s, 'title') || getStreamTag(s, 'name') || getLanguageName(lang)
      });
    }
  });

  // 6. Segment Video & Audio
  console.log('Running FFmpeg segmenting on video...');
  const playlistPath = path.join(OUTPUT_DIR, 'variant.m3u8');
  const segmentPattern = path.join(OUTPUT_DIR, 'seg%05d.m4s');

  const ffmpegArgs = [
    'ffmpeg',
    '-y',
    '-i', `"${INPUT_FILE}"`,
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `"${segmentPattern}"`,
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'independent_segments',
    '-map', '0:v'
  ];

  if (kind === 'original') {
    ffmpegArgs.push('-c:v', 'copy');
  } else {
    // Compressed variant
    const tHeight = target_height || 1080;
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', hls_preset,
      '-crf', hls_crf,
      '-vf', `"scale='trunc(oh*a/2)*2':'trunc(min(${tHeight},ih)/2)*2'"`,
      '-force_key_frames', '"expr:gte(t,n_forced*6)"'
    );
  }

  ffmpegArgs.push(`"${playlistPath}"`);
  const ffmpegCmd = ffmpegArgs.flat().join(' ');
  console.log(`Executing FFmpeg command: ${ffmpegCmd}`);
  execSync(ffmpegCmd, { stdio: 'inherit' });

  // 7. Segment Subtitles (only for the 'original' variant - shared across all variants via master playlist)
  const subtitlePlaylists = [];
  if (kind === 'original' && subtitleStreams.length > 0) {
    console.log(`Processing ${subtitleStreams.length} subtitle streams...`);
    for (const sub of subtitleStreams) {
      console.log(`Converting subtitle stream #${sub.index} (${sub.codec})...`);
      const subPlaylistPath = path.join(OUTPUT_DIR, `subtitle_${sub.index}.m3u8`);
      const subSegmentPattern = path.join(OUTPUT_DIR, `subtitle_${sub.index}_%05d.vtt`);
      
      const subFfmpegCmd = `ffmpeg -y -i "${INPUT_FILE}" -vn -an -map 0:${sub.index} -c:s webvtt -f segment -segment_time 6 -write_empty_segments 1 -segment_list_type m3u8 -segment_list "${subPlaylistPath}" "${subSegmentPattern}"`;
      console.log(`Executing Subtitle FFmpeg command: ${subFfmpegCmd}`);
      
      try {
        execSync(subFfmpegCmd, { stdio: 'inherit' });
        const rawSubPlaylist = fs.readFileSync(subPlaylistPath, 'utf8');
        subtitlePlaylists.push({
          streamIndex: sub.index,
          language: sub.language,
          title: sub.title,
          playlistText: rawSubPlaylist
        });
      } catch (err) {
        console.warn(`Warning: Failed to convert subtitle stream #${sub.index}. Skipping.`);
      }
    }
  }

  // 7.5 Segment all audio tracks (only for the 'original' variant - shared across all variants via master playlist)
  const audioPlaylists = [];
  if (kind === 'original' && audioStreams.length > 0) {
    console.log(`Processing audio tracks (found ${audioStreams.length} total)...`);
    for (const aud of audioStreams) {
      console.log(`Converting audio stream #${aud.index} (${aud.codec})...`);
      const audPlaylistPath = path.join(OUTPUT_DIR, `audio_${aud.index}.m3u8`);
      const audSegmentPattern = path.join(OUTPUT_DIR, `audio_${aud.index}_%05d.m4s`);
      const audInitName = `audio_${aud.index}_init.mp4`;
      
      const audFfmpegCmd = `ffmpeg -y -i "${INPUT_FILE}" -vn -map 0:${aud.index} -c:a aac -b:a 192k -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_type fmp4 -hls_segment_filename "${audSegmentPattern}" -hls_fmp4_init_filename "${audInitName}" "${audPlaylistPath}"`;
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

  // Delete input file to release space
  fs.unlinkSync(INPUT_FILE);

  // 8. ZIP segments in batches (up to 1GB limit)
  console.log('Grouping segments and packaging ZIPs...');
  const allOutputFiles = fs.readdirSync(OUTPUT_DIR)
    .filter(name => name.endsWith('.m4s') || name.endsWith('.vtt') || name.endsWith('.mp4'))
    .map(name => {
      const fullPath = path.join(OUTPUT_DIR, name);
      const size = fs.statSync(fullPath).size;
      
      let segmentIndex = null;
      const segMatch = name.match(/seg(\d{5})\.m4s/);
      if (segMatch) {
        segmentIndex = parseInt(segMatch[1], 10);
      } else {
        const subMatch = name.match(/subtitle_\d+_(\d{5})\.vtt/);
        if (subMatch) {
          segmentIndex = parseInt(subMatch[1], 10);
        } else {
          const audMatch = name.match(/audio_\d+_(\d{5})\.m4s/);
          if (audMatch) {
            segmentIndex = parseInt(audMatch[1], 10);
          }
        }
      }
      return { name, fullPath, size, segmentIndex };
    });

  allOutputFiles.sort((a, b) => {
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

  const completedZips = [];
  let currentZipSize = 0;
  let currentZipIndex = 0;
  let pendingFiles = [];
  let segmentStart = null;
  let segmentEnd = null;

  async function uploadZipBatch() {
    if (pendingFiles.length === 0) return;
    
    const zipName = `segments-${label}-part${currentZipIndex.toString().padStart(4, '0')}.zip`;
    const zipPath = path.join(WORK_DIR, zipName);
    
    console.log(`Packaging ZIP ${zipName} with ${pendingFiles.length} segments...`);
    const fileArgs = pendingFiles.map(f => `"${f.fullPath}"`).join(' ');
    // Use system zip utility with compression level 0 (store only) for maximum speed
    execSync(`zip -0 -j "${zipPath}" ${fileArgs}`, { stdio: 'ignore' });
    
    const zipSize = fs.statSync(zipPath).size;
    console.log(`Uploading ${zipName} (${(zipSize / 1024 / 1024).toFixed(1)} MB)...`);
    const uploadRes = await uploadAssetWithRotation(zipName, zipPath, 'application/zip');
    
    completedZips.push({
      zipIndex: currentZipIndex,
      assetId: uploadRes.id,
      url: uploadRes.browser_download_url,
      zipSize,
      segmentStart,
      segmentEnd
    });
    
    fs.unlinkSync(zipPath);
    // Cleanup the uploaded segment files to keep disk usage low
    for (const f of pendingFiles) {
      try { fs.unlinkSync(f.fullPath); } catch (e) {}
    }
    
    currentZipIndex++;
    currentZipSize = 0;
    pendingFiles = [];
    segmentStart = null;
    segmentEnd = null;
  }

  for (const file of allOutputFiles) {
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

  // 9. Rewrite and Upload Manifests
  console.log('Rewriting manifests to absolute paths...');
  const mainPlaylistText = fs.readFileSync(playlistPath, 'utf8');
  const rewrittenMainPlaylist = rewriteVariantPlaylist({
    playlistText: mainPlaylistText,
    fileId: file_id,
    label
  });

  const rewrittenSubtitlePlaylists = [];
  for (const subPlaylist of subtitlePlaylists) {
    const rewrittenText = rewriteVariantPlaylist({
      playlistText: subPlaylist.playlistText,
      fileId: file_id,
      label
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
      label
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

  const mainPlaylistTmpPath = path.join(WORK_DIR, 'playlist.m3u8');
  fs.writeFileSync(mainPlaylistTmpPath, rewrittenMainPlaylist);
  console.log('Uploading rewritten main HLS playlist...');
  await uploadAssetWithRotation('playlist.m3u8', mainPlaylistTmpPath, 'application/vnd.apple.mpegurl');
  fs.unlinkSync(mainPlaylistTmpPath);

  // 10. Callback to VPS to notify completeness
  console.log(`Sending success callback to VPS at: ${vps_callback_url}`);

  // Build audio metadata for the master playlist. Every variant reports all audio
  // streams (so the backend can mark the default in the master regardless of which
  // variant finishes last). Since we are doing demuxed audio, all audio tracks (including
  // the default one) are uploaded as separate audio playlist assets (audio_<index>.m3u8)
  // and have their own URIs in the master playlist.
  const audiosForCallback = audioStreams.map((aud, i) => ({
    streamIndex: aud.index,
    language: aud.language,
    title: aud.title,
    isDefault: i === 0
  }));

  const callbackBody = {
    fileId: file_id,
    userId: user_id,
    label,
    kind,
    width: outputWidth,
    height: outputHeight,
    codec: inferredCodec,
    githubReleaseId: release_id,
    githubReleaseIds,
    playlistText: rewrittenMainPlaylist,
    completedZips,
    // Only the original variant uploads subtitle/audio playlist assets.
    // Compressed variants send empty arrays here; the backend dedupes across variants
    // and sources the shared audio+subtitles from the original variant.
    subtitles: rewrittenSubtitlePlaylists,
    audios: audiosForCallback,
    token: vps_callback_token
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
