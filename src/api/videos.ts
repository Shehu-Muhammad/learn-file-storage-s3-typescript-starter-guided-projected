import { respondWithJSON } from "./json";
import { tmpdir } from "os";
import path from "path";
import { unlink } from "fs/promises";

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
  const key = `${videoId}.mp4`;

  try {
      await Bun.write(tempFilePath, file);
      const s3File = cfg.s3Client.file(key);
      const bunFile = Bun.file(tempFilePath)
      await s3File.write(bunFile, {type: mediaType});
  } finally {
    await unlink(tempFilePath)
  }

  //https://<bucket-name>.s3.<region>.amazonaws.com/<key>
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
