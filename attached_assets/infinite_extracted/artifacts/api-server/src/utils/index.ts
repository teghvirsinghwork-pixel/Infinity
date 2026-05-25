export function encodeId(url: string): string {
  return "hd4u:" + Buffer.from(url).toString("base64url");
}

export function decodeId(id: string): string {
  const raw = id.startsWith("hd4u:") ? id.slice(5) : id;
  return Buffer.from(raw, "base64url").toString("utf8");
}

export function b64Decode(str: string): string {
  return Buffer.from(str, "base64").toString("utf8");
}

export function getBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

export function getIndexQuality(header: string): number {
  const m = /(\d{3,4})p/.exec(header);
  return m ? parseInt(m[1]!) : 0;
}

const QUALITY_TAGS = /\b(4K|2160p?|1080p?|720p?|480p?|360p?|HEVC|HDRip?|BluRay|BRRip?|DVDRip?|WEBRip?|WEB-DL|HDCAM|CAM|TS|PDVD|HQ|HD|SD)\b/gi;

export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*\(?\d{4}\)?$/, "")
    .replace(QUALITY_TAGS, "")
    .replace(/\s*[-–|:]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getSearchQuality(title: string): string | null {
  const m = QUALITY_TAGS.exec(title);
  QUALITY_TAGS.lastIndex = 0;
  return m ? m[0] : null;
}

export function getRedirectLinks(html: string, _baseUrl: string): string[] {
  const links: string[] = [];
  const pattern = /href=["']([^"']+(?:hubcloud|hubdrive|hubcdn|hblinks)[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    links.push(m[1]!);
  }
  return links;
}
