'use client';
// Client-side image helpers: shrink payment proofs and square station logos before they are sent
// to the database as data URLs (no file storage involved).

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('לא הצלחנו לקרוא את התמונה. נסו צילום מסך בפורמט JPG או PNG.'));
    };
    img.src = url;
  });
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('לא הצלחנו לקרוא את הקובץ'));
    r.readAsDataURL(file);
  });
}

export const PROOF_MAX_CHARS = 1_500_000;
export const LOGO_MAX_CHARS = 400_000;

export type Proof = { data: string; kind: 'image' | 'pdf'; name: string; size: number };

/** A payment proof: an image is shrunk to max 1600px JPEG; a PDF must be up to 1MB. */
export async function prepareProof(file: File): Promise<Proof> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    if (file.size > 1_000_000) throw new Error('קובץ ה-PDF גדול מ-1MB. אפשר לשלוח צילום מסך במקומו.');
    const raw = await readDataUrl(file);
    const b64 = raw.slice(raw.indexOf(',') + 1);
    const data = 'data:application/pdf;base64,' + b64;
    if (data.length > PROOF_MAX_CHARS) throw new Error('קובץ ה-PDF גדול מדי. אפשר לשלוח צילום מסך במקומו.');
    return { data, kind: 'pdf', name: file.name, size: file.size };
  }
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) {
    throw new Error('אפשר לצרף תמונה או קובץ PDF בלבד');
  }
  const img = await loadImage(file);
  const tries: [number, number][] = [
    [1600, 0.8],
    [1400, 0.7],
    [1100, 0.6],
  ];
  for (const [max, q] of tries) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('הדפדפן לא מאפשר לעבד תמונות');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const data = c.toDataURL('image/jpeg', q);
    if (data.length <= PROOF_MAX_CHARS) return { data, kind: 'image', name: file.name, size: Math.round((data.length * 3) / 4) };
  }
  throw new Error('התמונה גדולה מדי גם אחרי הקטנה. נסו צילום מסך של האישור בלבד.');
}

/** A station logo: drawn into a 256×256 square (contain), PNG with a transparent background. */
export async function prepareLogo(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('אפשר להעלות תמונה בלבד (PNG / JPG / WEBP)');
  const img = await loadImage(file);
  const S = 256;
  const draw = (bg: string | null) => {
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('הדפדפן לא מאפשר לעבד תמונות');
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, S, S);
    }
    const scale = Math.min(S / (img.naturalWidth || 1), S / (img.naturalHeight || 1));
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    return c;
  };
  const ok = (d: string) => /^data:image\/(png|jpeg|webp);base64,/.test(d) && d.length < LOGO_MAX_CHARS;
  const png = draw(null).toDataURL('image/png');
  if (ok(png)) return png;
  const webp = draw(null).toDataURL('image/webp', 0.9);
  if (ok(webp)) return webp;
  const jpg = draw('#ffffff').toDataURL('image/jpeg', 0.85);
  if (ok(jpg)) return jpg;
  throw new Error('הלוגו גדול מדי. נסו תמונה פשוטה יותר.');
}
