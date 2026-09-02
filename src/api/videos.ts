import { respondWithJSON } from "./json";
import { tmpdir } from "os";
import path from "path";
import { rm } from "fs/promises";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as {videoId?: string};
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      `Video file exceeds the maximum allowed size of 1GB`,
    );
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for video");
  }

  if (mediaType !== "video/mp4") {
    throw new BadRequestError(
      `Invalid video file type. Only MP4 is allowed.`,
    );
  }

  const tempFilePath = path.join(tmpdir(), `${videoId}.mp4`);
  let processedFilePath = "";
  let key = "";
  try {
      await Bun.write(tempFilePath, file);
      processedFilePath = await processVideoForFastStart(tempFilePath);
      const aspectRatio = await getVideoAspectRatio(processedFilePath);
      key = `${aspectRatio}/${videoId}.mp4`;
      const s3File = cfg.s3Client.file(key);
      const bunFile = Bun.file(processedFilePath);
      await s3File.write(bunFile, {type: mediaType});
  } finally {
    await Promise.all([rm(processedFilePath, { force: true }), rm(tempFilePath, { force: true })]); 
  }

  //https://<bucket-name>.s3.<region>.amazonaws.com/<key>
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText);
  }

  const output = JSON.parse(stdoutText);
  const {height, width} = output.streams[0];

  const ratio = width/height;
  const portrait = 9/16;
  const landscape = 16/9;
  const tolerance = 0.01;
  if (Math.abs(ratio-portrait) < tolerance) {
    return "portrait";
  } else if (Math.abs(ratio-landscape) < tolerance) {
    return "landscape";
  } else {
    return "other";
  }
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed.mp4`;
  const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputFilePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText);
  }

  return outputFilePath;
}