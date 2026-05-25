export interface Stream {
  name: string;
  title: string;
  url: string;
  type?: "hls" | "mp4" | "torrent";
  headers?: Record<string, string>;
  behaviorHints?: {
    notWebReady?: boolean;
    proxyHeaders?: {
      request?: Record<string, string>;
    };
  };
}

export interface Subtitle {
  lang: string;
  url: string;
}
