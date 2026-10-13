// A QR-looking picture (not scannable – the demo has no real WhatsApp to link).
function cells(value: string, n: number) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  const out: boolean[] = [];
  for (let i = 0; i < n * n; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    out.push((h >>> 0) % 100 < 47);
  }
  return out;
}
export function QRCodeSVG({ value = '', size = 128, bgColor = '#ffffff', fgColor = '#000000', className, style, includeMargin, marginSize, level, title, ...rest }: any) {
  const n = 29;
  const c = cells(String(value), n);
  const finder = (x: number, y: number) => x < 7 && y < 7;
  const inFinder = (x: number, y: number) => finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y);
  const rects: any[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (!inFinder(x, y) && c[y * n + x]) rects.push(<rect key={x + '-' + y} x={x} y={y} width={1.02} height={1.02} />);
  const eye = (x: number, y: number) => (
    <g key={'e' + x + y}>
      <rect x={x} y={y} width={7} height={7} />
      <rect x={x + 1} y={y + 1} width={5} height={5} fill={bgColor} />
      <rect x={x + 2} y={y + 2} width={3} height={3} />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`-2 -2 ${n + 4} ${n + 4}`} className={className} style={style} shapeRendering="crispEdges" role="img" aria-label={title || 'QR'} {...rest}>
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill={bgColor} />
      <g fill={fgColor}>
        {rects}
        {eye(0, 0)}
        {eye(n - 7, 0)}
        {eye(0, n - 7)}
      </g>
    </svg>
  );
}
export const QRCodeCanvas = QRCodeSVG;
export default QRCodeSVG;
