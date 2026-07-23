/**
 * ffmpeg-static ships a bundled ffmpeg binary but no TypeScript types. Its
 * default export is the absolute path to the binary for the current platform,
 * or null when no binary is available (unsupported platform / download failed).
 */
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null
  export default ffmpegPath
}
