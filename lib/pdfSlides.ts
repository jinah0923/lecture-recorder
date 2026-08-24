"use client";

import type { SlideImage } from "@/lib/types";

// Full-resolution slides cached for on-screen display (matched against
// `![슬라이드 N](slide_N)` placeholders the AI writes into the lecture note).
const DISPLAY_WIDTH_PX = 1024;
const DISPLAY_QUALITY = 0.7;
// A much smaller, more compressed copy is what actually goes to Gemini —
// keeps the analyze request's payload light regardless of how many slides
// a deck has.
const THUMBNAIL_WIDTH_PX = 640;
const THUMBNAIL_QUALITY = 0.5;

let workerConfigured = false;

async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    workerConfigured = true;
  }
  return pdfjsLib;
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  // toDataURL silently falls back to PNG in browsers without WebP encode
  // support — still a valid image, just a larger one, never a thrown error.
  return canvas.toDataURL("image/webp", quality);
}

// Renders every page of a PDF to a canvas and exports each as a WebP data
// URL at DISPLAY_WIDTH_PX wide — these are what NoteViewer/SlideImage shows
// on screen and what gets cached in IndexedDB for later viewing.
export async function extractPdfSlides(file: Blob): Promise<SlideImage[]> {
  const pdfjsLib = await loadPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const slides: SlideImage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = DISPLAY_WIDTH_PX / baseViewport.width;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      if (!canvas.getContext("2d")) continue;

      await page.render({ canvas, viewport }).promise;
      slides.push({ page: pageNumber, dataUrl: canvasToDataUrl(canvas, DISPLAY_QUALITY) });
    }
  } finally {
    await loadingTask.destroy();
  }

  return slides;
}

function downscaleDataUrl(dataUrl: string, targetWidth: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, targetWidth / img.naturalWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("캔버스 컨텍스트를 생성하지 못했습니다."));
        return;
      }
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvasToDataUrl(canvas, quality));
    };
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = dataUrl;
  });
}

// Compresses already-extracted display-res slides down to small thumbnails
// for the Gemini request — never re-reads the PDF itself.
export async function buildSlideThumbnails(slides: SlideImage[]): Promise<SlideImage[]> {
  const thumbnails: SlideImage[] = [];
  for (const slide of slides) {
    try {
      const dataUrl = await downscaleDataUrl(slide.dataUrl, THUMBNAIL_WIDTH_PX, THUMBNAIL_QUALITY);
      thumbnails.push({ page: slide.page, dataUrl });
    } catch {
      // Skip a slide that fails to downscale rather than failing the whole
      // analyze request over one bad image.
    }
  }
  return thumbnails;
}
