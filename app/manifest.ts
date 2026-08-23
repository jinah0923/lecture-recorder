import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/?source=pwa",
    name: "Lecture Recorder - AI 스마트 강의노트",
    short_name: "강의노트",
    description: "AI 기반 스마트 강의 녹음, 요약 및 상세 노트",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#4f46e5",
    // Chrome's install prompt on Android checks this before offering the
    // native (Play Store / related-app) install path — false keeps it
    // pointed at the web app / WebAPK install instead.
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        // The manifest spec allows space-separated purpose keywords, but
        // Next's type only models a single value — cast to keep the actual
        // ("any maskable") string in the served JSON.
        purpose: "any maskable" as NonNullable<MetadataRoute.Manifest["icons"]>[number]["purpose"],
      },
    ],
  };
}
