import { getVideoAspectRatio } from "../api/videos";

async function main() {
    const portraitFilePath = "../../samples/boots-video-vertical.mp4";
    const landscapeFilePath = "../../samples/boots-video-horizontal.mp4";
    const filePaths = [portraitFilePath, landscapeFilePath];

    filePaths.forEach(async (link) => {
        let result = await getVideoAspectRatio(link);
        console.log(result);
    });
}

main();

// to run the file run cmd
// bun run <filename>