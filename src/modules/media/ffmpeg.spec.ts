import { buildMasterPlaylist, ladderBasis, ladderFor } from "./ffmpeg";

describe("ladderFor", () => {
  const names = (h: number) => ladderFor(h).map((r) => r.name);

  it("720p source -> 240p, 480p, 720p", () => {
    expect(names(720)).toEqual(["240p", "480p", "720p"]);
  });

  it("1440p source is capped at 1080p: four rungs ending 1080p", () => {
    expect(names(1440)).toEqual(["240p", "480p", "720p", "1080p"]);
    expect(ladderFor(1440).at(-1)?.name).toBe("1080p");
  });

  it("a source below 240p still gets the 240p rung", () => {
    expect(names(200)).toEqual(["240p"]);
    expect(names(1)).toEqual(["240p"]);
  });

  it("includes a rung when the source is exactly that tall, excludes it when one pixel shorter", () => {
    expect(names(1080)).toEqual(["240p", "480p", "720p", "1080p"]);
    expect(names(1079)).toEqual(["240p", "480p", "720p"]);
    expect(names(480)).toEqual(["240p", "480p"]);
    expect(names(479)).toEqual(["240p"]);
  });

  it("carries the plan's bitrates: video 400/1000/2500/5000k, audio 96k (240p/480p) and 128k above", () => {
    expect(ladderFor(1080).map((r) => [r.height, r.videoKbps, r.audioKbps])).toEqual([
      [240, 400, 96],
      [480, 1000, 96],
      [720, 2500, 128],
      [1080, 5000, 128],
    ]);
  });
});

describe("ladderBasis", () => {
  it("landscape sources ladder on height, portrait on width", () => {
    expect(ladderBasis({ width: 1920, height: 1080 })).toBe(1080);
    expect(ladderBasis({ width: 360, height: 640 })).toBe(360);
    expect(ladderBasis({ width: 720, height: 720 })).toBe(720);
  });
});

describe("buildMasterPlaylist", () => {
  it("lists every rendition with bandwidth and resolution", () => {
    const text = buildMasterPlaylist([
      { name: "240p", height: 240, width: 426, videoKbps: 400, audioKbps: 96 },
      { name: "480p", height: 480, width: 854, videoKbps: 1000, audioKbps: 96 },
    ]);
    expect(text.startsWith("#EXTM3U")).toBe(true);
    expect(text).toContain("#EXT-X-STREAM-INF:BANDWIDTH=496000,RESOLUTION=426x240");
    expect(text).toContain("240p/index.m3u8");
    expect(text).toContain("#EXT-X-STREAM-INF:BANDWIDTH=1096000,RESOLUTION=854x480");
    expect(text.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
  });
});
