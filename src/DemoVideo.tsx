import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DemoVideoSource } from "./types";

/** Promo video player; the hosted trial serves the files, the local package has none. */
export default function DemoVideo({ video, onClose }: { video: DemoVideoSource; onClose: () => void }) {
  // Start light: the server's ~3 Mbps uplink is shared, and the Cloudflare route is slow from China.
  const [quality, setQuality] = useState<"hd" | "sd">(video.sd ? "sd" : "hd");
  const player = useRef<HTMLVideoElement>(null);
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  function switchQuality(next: "hd" | "sd") {
    if (next === quality) return;
    // Keep the position when switching, so a stalled viewer does not restart the video.
    if (player.current) resume.current = { time: player.current.currentTime, playing: !player.current.paused };
    setQuality(next);
  }
  function restore() {
    const state = resume.current, element = player.current;
    if (!state || !element) return;
    element.currentTime = state.time; resume.current = null;
    if (state.playing) void element.play().catch(() => {});
  }
  const source = quality === "sd" && video.sd ? video.sd : video.hd;
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="model-dialog demo-video-dialog" role="dialog" aria-modal="true" aria-label="演示视频" onClick={(event) => event.stopPropagation()}>
      <header><h2>演示视频 · 约 4 分 30 秒</h2><button type="button" className="icon-button" aria-label="关闭演示视频" onClick={onClose}><X size={18} /></button></header>
      <div className="demo-video-body">
        <video key={source} ref={player} src={source} poster={video.poster} controls autoPlay playsInline preload="metadata" onLoadedMetadata={restore} />
        <div className="demo-video-footer">
          <p className="muted">画面为本地工作台真实操作，等待模型的片段已加速并标注倍速；配音为语音合成。</p>
          {video.sd ? <div className="theme-switch demo-video-quality" role="group" aria-label="清晰度">
            <button type="button" aria-pressed={quality === "hd"} onClick={() => switchQuality("hd")}>高清 1080p</button>
            <button type="button" aria-pressed={quality === "sd"} onClick={() => switchQuality("sd")}>流畅 720p</button>
          </div> : null}
        </div>
      </div>
    </section>
  </div>;
}
