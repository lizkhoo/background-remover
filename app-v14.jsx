// app-v4.jsx — Background Remover, radically simplified to seed-driven cutout
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// Persisted Tweaks
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "thumbSize": 168,
  "engine": "birefnet",
  "tolerance": 32
}/*EDITMODE-END*/;

// ─────────────────────────────────────────────────────────────────────────
// Seed-color cutout filter — keys out pixels close to picked seed colors.
// For each seed C we compute a per-channel "distance" via:
//   1. feColorMatrix:   shift channels so C maps to mid-grey (0.5,0.5,0.5)
//   2. feComponentTransfer table [1,0,1]: V-curve makes |x-0.5|*2 (proximity → 0)
//   3. feColorMatrix:   sum R+G+B into alpha (smaller = closer to seed)
//   4. feComponentTransfer slope/intercept: threshold so close→0, far→1
// Multiple seeds → run the chain per seed and multiply the alphas with feComposite "in".
function SeedCutoutFilter({id, seeds, tolerance, edgeQuality, mode='cutout'}){
  // tolerance 0..100 — bigger means we accept more of a color shift as "background"
  const t = Math.max(2, tolerance) / 100;            // 0.02..1
  const slope    = 1 / Math.max(0.05, t * 0.55);     // sharpness of the threshold
  const intercept = -slope * (t * 0.55) + 0.5;       // center the falloff at the radius
  const q = edgeQuality / 100;
  const featherStdDev = Math.max(0.2, q * 1.4 + 0.4);

  const list = (seeds && seeds.length) ? seeds.slice(0, 5) : [];

  return (
    <filter id={id} x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
      {/* light denoise */}
      <feGaussianBlur in="SourceGraphic" stdDeviation="0.5" result="src"/>

      {list.length === 0 ? (
        // No seeds — pass through fully opaque
        <feColorMatrix in="src" type="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="alpha"/>
      ) : (
        list.map((c, i) => {
          const cr = c.r/255, cg = c.g/255, cb = c.b/255;
          // shift: x' = x + (0.5 - Cx); seed becomes 0.5
          const m = `1 0 0 0 ${0.5 - cr}  0 1 0 0 ${0.5 - cg}  0 0 1 0 ${0.5 - cb}  0 0 0 1 0`;
          const shifted = `shifted-${i}`;
          const vcurve  = `vcurve-${i}`;
          const dist    = `dist-${i}`;
          const alpha   = `alpha-${i}`;
          return (
            <React.Fragment key={i}>
              <feColorMatrix in="src" type="matrix" values={m} result={shifted}/>
              {/* V-curve: 0→1, 0.5→0, 1→1 — gives |x - Cx|*2 */}
              <feComponentTransfer in={shifted} result={vcurve}>
                <feFuncR type="table" tableValues="1 0 1"/>
                <feFuncG type="table" tableValues="1 0 1"/>
                <feFuncB type="table" tableValues="1 0 1"/>
              </feComponentTransfer>
              {/* sum channels into a single distance, drop into alpha */}
              <feColorMatrix in={vcurve} type="matrix"
                values={`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${1/3} ${1/3} ${1/3} 0 0`} result={dist}/>
              {/* threshold: small distance → 0, large → 1 */}
              <feComponentTransfer in={dist} result={alpha}>
                <feFuncA type="linear" slope={slope} intercept={intercept}/>
              </feComponentTransfer>
              {/* combine with running alpha (multiplicative — every seed must agree it's foreground) */}
              {i === 0
                ? <feColorMatrix in={alpha} type="matrix"
                    values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="alpha"/>
                : <feComposite in="alpha" in2={alpha} operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="alpha"/>}
            </React.Fragment>
          );
        })
      )}

      {/* feather */}
      <feGaussianBlur in="alpha" stdDeviation={featherStdDev} result="alphaSoft"/>

      {mode === 'matte' ? (
        // Render alpha as white-on-black
        <>
          <feFlood floodColor="#ffffff" result="white"/>
          <feComposite in="white" in2="alphaSoft" operator="in"/>
        </>
      ) : (
        // Mask original with alpha
        <feComposite in="SourceGraphic" in2="alphaSoft" operator="in"/>
      )}
    </filter>
  );
}

// Available subject-detection engines, ordered by accuracy
const ENGINES = {
  birefnet:  { name: 'BiRefNet',          tag: 'High accuracy',  size: '88 MB', sub: 'Best for product, fashion, hair' },
  modnet:    { name: 'MODNet',            tag: 'Balanced',       size: '24 MB', sub: 'General purpose, fast' },
  selfie:    { name: 'Selfie Segmenter',  tag: 'Fast',           size: '6 MB',  sub: 'People only, real-time' },
};

// ─────────────────────────────────────────────────────────────────────────
// Static histogram bins (faked, but visually consistent)
function makeHistogram(seed){
  const rng = (n) => { let x = Math.sin(seed * 9301 + n * 49297) * 233280; return x - Math.floor(x); };
  const bins = [];
  for(let i=0;i<48;i++){
    const a = Math.exp(-Math.pow((i-12)/8, 2)) * 0.7;   // bg cluster left
    const b = Math.exp(-Math.pow((i-34)/9, 2)) * 1.0;   // subject cluster right
    const noise = rng(i) * 0.15;
    bins.push(Math.min(1, a + b + noise) * 100);
  }
  return bins;
}

// ─────────────────────────────────────────────────────────────────────────
// Rasterize a set of brush strokes into a black/white mask at w×h. White =
// covered by a stroke. Used by BOTH the protect brush (Restore — keep opaque)
// and the erase brush (Paintbrush — make transparent), and by both the live
// preview and the full-res rasterizer. `size` is in image-natural px; pass
// radiusScale = w / naturalWidth when rendering into a downscaled canvas.
// Returns the mask's pixel data (read the red channel: > 128 = covered), or
// null when there are no strokes.
function strokesToMask(strokes, w, h, radiusScale){
  if(!strokes || !strokes.length) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for(const s of strokes){
    const r = ((s.size || 36) / 2) * radiusScale;
    const pts = s.points || [];
    if(!pts.length) continue;
    // dots at every point (covers single-tap dabs and round caps)
    for(const p of pts){
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // polyline segments between points
    if(pts.length > 1){
      ctx.lineWidth = r * 2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      for(let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * w, pts[i].y * h);
      ctx.stroke();
    }
  }
  return ctx.getImageData(0, 0, w, h).data;
}

// ─────────────────────────────────────────────────────────────────────────
// Real cutout rasterizer — runs the same seed-color logic as the SVG filter,
// but on a 2D canvas so we can produce a real PNG/WebP/JPG blob for Keep + Export.
// Returns a Promise<{dataUrl, blob, width, height}>.
function rasterizeCutout(image, seeds, format='png'){
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const W = im.naturalWidth || 512;
        const H = im.naturalHeight || 512;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0, W, H);
        const imgData = ctx.getImageData(0, 0, W, H);
        const data = imgData.data;

        // Sample seed colors — must match SingleCanvas/effectiveSeedColors logic:
        // user-picked bgSamples take priority, then box-corner probes fill in.
        // (Previously this only sampled box corners, so Sample-mode picks were
        //  silently dropped on Keep/Export — the cutout looked right on screen
        //  but the rasterized output ignored every sampled color past the first
        //  one that happened to coincide with a corner.)
        const seedColors = [];
        // Exact-match dedup — keep every user-picked sample. The previous
        // 32-step bucket dropped distinct user clicks at export time.
        const exactKey = (c) => `${c.r},${c.g},${c.b}`;
        const seen = new Set();
        const sampleAt = (u, v) => {
          const x = Math.max(0, Math.min(W-1, Math.floor(u * W)));
          const y = Math.max(0, Math.min(H-1, Math.floor(v * H)));
          const i = (y*W + x) * 4;
          return {r:data[i], g:data[i+1], b:data[i+2]};
        };
        const push = (c) => {
          if(!c) return;
          const k = exactKey(c);
          if(seen.has(k)) return;
          seen.add(k);
          seedColors.push(c);
        };
        // user-picked background colors come first
        for(const c of (seeds?.bgSamples || [])){
          push(c);
          if(seedColors.length >= 8) break;
        }
        const boxes = (seeds?.boxes && seeds.boxes.length) ? seeds.boxes
          : (seeds?.box ? [seeds.box] : []);
        if(boxes.length && seedColors.length < 8){
          const inAnyBox = (x, y) => boxes.some(b => x >= b.x && x <= b.x+b.w && y >= b.y && y <= b.y+b.h);
          const probes = [
            {x:0.02, y:0.02}, {x:0.98, y:0.02},
            {x:0.02, y:0.98}, {x:0.98, y:0.98},
            {x:0.5,  y:0.02}, {x:0.5,  y:0.98},
          ].filter(p => !inAnyBox(p.x, p.y));
          for(const p of probes){
            push(sampleAt(p.x, p.y));
            if(seedColors.length >= 8) break;
          }
        }

        // Brush masks (full image-natural resolution → radiusScale = 1; stroke
        // `size` is already in image-natural px). Protect = keep opaque,
        // Erase = force transparent. Same polyline-with-round-caps approach the
        // live preview uses, so the Kept cutout matches what the user saw.
        const protectMask = strokesToMask(seeds?.protectStrokes, W, H, 1);
        const eraseMask   = strokesToMask(seeds?.eraseStrokes,   W, H, 1);
        const isProtected = (px, py) => protectMask ? protectMask[(py*W + px) * 4] > 128 : false;
        const isErased    = (px, py) => eraseMask   ? eraseMask[(py*W + px) * 4]   > 128 : false;

        const tolerance = (seeds?.tolerance ?? 32);
        const t = Math.max(2, tolerance) / 100;
        const radius = t * 0.55 * 255 * Math.sqrt(3); // distance threshold in 0..255 RGB space
        const softness = radius * 0.35;

        if(seedColors.length === 0 && !eraseMask){
          // No box / no seed colors / no erase strokes — keep the image as-is.
          // Protect strokes alone shouldn't erase the whole image (that's how v7
          // behaved); they only override the seed-color cutout once one is in play.
        } else {
          // For each pixel: protect wins (stay opaque), then erase (force
          // transparent), else seed-color min-distance alpha (if any seeds).
          // alpha = smoothstep(radius - softness, radius + softness, dist)
          const lo = radius - softness;
          const hi = radius + softness;
          const range = Math.max(1, hi - lo);
          const hasColor = seedColors.length > 0;
          for(let y=0;y<H;y++){
            for(let x=0;x<W;x++){
              const i = (y*W + x) * 4;
              if(isProtected(x, y)){ continue; }       // keep fully opaque
              if(isErased(x, y)){ data[i+3] = 0; continue; } // paint → transparent
              if(!hasColor){ continue; }                // erase-only image: leave rest opaque
              const r = data[i], g = data[i+1], bl = data[i+2];
              let best = Infinity;
              for(const c of seedColors){
                const dr = r - c.r, dg = g - c.g, db = bl - c.b;
                const d2 = dr*dr + dg*dg + db*db;
                if(d2 < best) best = d2;
              }
              const dist = Math.sqrt(best);
              let a;
              if(dist <= lo) a = 0;
              else if(dist >= hi) a = 255;
              else a = Math.round(((dist - lo) / range) * 255);
              data[i+3] = a;
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);

        const fmt = (format||'png').toLowerCase();
        const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg'
                  : fmt === 'webp' ? 'image/webp' : 'image/png';
        // For JPG, flatten transparency over white (JPG has no alpha)
        if(mime === 'image/jpeg'){
          const out = document.createElement('canvas');
          out.width = W; out.height = H;
          const octx = out.getContext('2d');
          octx.fillStyle = '#ffffff';
          octx.fillRect(0, 0, W, H);
          octx.drawImage(c, 0, 0);
          out.toBlob(blob => {
            resolve({dataUrl: out.toDataURL(mime, 0.92), blob, width: W, height: H});
          }, mime, 0.92);
          return;
        }
        c.toBlob(blob => {
          resolve({dataUrl: c.toDataURL(mime), blob, width: W, height: H});
        }, mime);
      } catch(err){ reject(err); }
    };
    im.onerror = () => reject(new Error('Image load failed'));
    im.src = image.original;
  });
}

// Trigger a browser download for a Blob
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

// ─────────────────────────────────────────────────────────────────────────
// AI image analysis — asks Claude to look at the image and describe what
// to keep vs remove, returning a structured JSON the app can apply directly
// as boxes + protect strokes.
//
// Returns: { description, boxes:[{x,y,w,h}], protectStrokes:[{points:[{x,y}], size}], tolerance, confidence }
// All coordinates are normalized to 0..1 (image space).
async function analyzeImageWithClaude(image){
  // Load the image so we can sample colors and dimensions for the prompt.
  // (We can't send the actual image bytes — window.claude.complete is text-only —
  // so we summarize the image into text features Claude can reason about.)
  const im = await new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Image load failed'));
    i.src = image.original;
  });
  const W = im.naturalWidth, H = im.naturalHeight;
  // Render small for sampling
  const SW = 64, SH = 64;
  const c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  const cx = c.getContext('2d');
  cx.drawImage(im, 0, 0, SW, SH);
  const data = cx.getImageData(0, 0, SW, SH).data;

  // Sample edges (likely background) vs center (likely foreground)
  const sampleRegion = (x0, y0, x1, y1) => {
    let r=0, g=0, b=0, n=0;
    for(let y=y0; y<y1; y++){
      for(let x=x0; x<x1; x++){
        const i = (y*SW + x) * 4;
        r += data[i]; g += data[i+1]; b += data[i+2]; n++;
      }
    }
    return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
  };
  const corners = [
    sampleRegion(0, 0, 8, 8),
    sampleRegion(SW-8, 0, SW, 8),
    sampleRegion(0, SH-8, 8, SH),
    sampleRegion(SW-8, SH-8, SW, SH),
  ];
  const edges = [
    sampleRegion(SW/2-4, 0, SW/2+4, 4),
    sampleRegion(SW/2-4, SH-4, SW/2+4, SH),
    sampleRegion(0, SH/2-4, 4, SH/2+4),
    sampleRegion(SW-4, SH/2-4, SW, SH/2+4),
  ];
  const center = sampleRegion(SW/2-8, SH/2-8, SW/2+8, SH/2+8);
  const rgbHex = ([r,g,b]) => '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');

  const prompt = `You are planning a background-removal job for a single image. The image bytes can't be shared, so reason from these features:

- Filename: ${image.name}.${image.ext}
- Subject kind hint: ${image.kind || 'unknown'}
- Aspect: ${W}x${H}
- Average corner colors (likely background): ${corners.map(rgbHex).join(', ')}
- Average edge midpoints: ${edges.map(rgbHex).join(', ')}
- Center color (likely foreground): ${rgbHex(center)}

The tool samples background colors outside user-drawn boxes and erases matching pixels; "protect" strokes paint over foreground that must stay opaque. Coordinates are normalized 0..1 (top-left origin).

Output ONLY this JSON, no prose, no markdown:

{
  "description": "1-2 sentences naming the likely subject and background.",
  "boxes": [{"x":0.1,"y":0.1,"w":0.8,"h":0.8}],
  "protectStrokes": [{"points":[{"x":0.5,"y":0.4},{"x":0.5,"y":0.6}], "size": 60}],
  "tolerance": 32,
  "confidence": 0.8
}

Guidance:
- One box per disconnected subject. For a centered single subject, one tight-ish box (e.g. x:0.18 y:0.12 w:0.64 h:0.76).
- Each protectStroke is a polyline of 4–10 points tracing through the middle of a subject; size 40–70 for medium subjects.
- Tolerance 20–30 if corner colors are uniform; 40–55 if corner colors vary a lot (mixed background).
- Confidence 0.6–0.9.`;

  const reply = await window.claude.complete({
    messages: [{ role: 'user', content: prompt }],
  });

  // Try to parse JSON — strip code fences if present
  let text = String(reply || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(fence) text = fence[1].trim();
  // Find the first { ... last } block
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if(first >= 0 && last > first) text = text.slice(first, last+1);

  let plan;
  try { plan = JSON.parse(text); }
  catch(err){
    throw new Error('Could not parse AI response as JSON: ' + text.slice(0, 200));
  }

  // Sanity-clamp everything
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const boxes = (plan.boxes || []).map(b => ({
    x: clamp(+b.x || 0, 0, 1),
    y: clamp(+b.y || 0, 0, 1),
    w: clamp(+b.w || 0, 0, 1),
    h: clamp(+b.h || 0, 0, 1),
  })).filter(b => b.w > 0.02 && b.h > 0.02);

  const protectStrokes = (plan.protectStrokes || []).map(s => ({
    size: clamp(+s.size || 40, 8, 120),
    points: (s.points || []).map(p => ({
      x: clamp(+p.x || 0, 0, 1),
      y: clamp(+p.y || 0, 0, 1),
    })),
  })).filter(s => s.points.length >= 1);

  return {
    description: String(plan.description || '').slice(0, 400),
    boxes,
    protectStrokes,
    tolerance: clamp(+plan.tolerance || 32, 10, 100),
    confidence: clamp(+plan.confidence || 0.75, 0, 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Filename composer with tokens
// pattern: e.g. "{name}_cutout_{NN}.{ext}"
function composeName(pattern, image, index, ext){
  return pattern
    .replace(/\{name\}/g, image.name)
    .replace(/\{NN\}/g, String(index+1).padStart(2,'0'))
    .replace(/\{N\}/g, String(index+1))
    .replace(/\{kind\}/g, image.kind)
    .replace(/\{ext\}/g, ext);
}

// ─────────────────────────────────────────────────────────────────────────
// Top toolbar
function Toolbar({view, setView, onLoad, onExport, onAnalyze, analyzing, processedCount, totalCount, dirName, hasFolder}){
  return (
    <div className="toolbar">
      <div className="brand">
        <div className="brand-mark"></div>
        <div className="brand-name">Cut-Cut bg rmvr</div>
        <span className="brand-tag">v0.5 · AI</span>
      </div>

      <div className="divider"/>

      <div className="seg" role="tablist" aria-label="Preview mode">
        <button className={view==='single'?'on':''} onClick={()=>setView('single')}>
          <Icon.Single/> Single
        </button>
        <button className={view==='contact'?'on':''} onClick={()=>setView('contact')}>
          <Icon.Grid/> Contact sheet
        </button>
      </div>

      <div className="spacer"/>

      <span className="mono" style={{color:'var(--fg-2)',fontSize:11,marginRight:6}}>
        {processedCount}/{totalCount} processed
      </span>

      <button className="tb-btn ghost" onClick={onAnalyze} disabled={!onAnalyze || analyzing} style={analyzing ? {opacity:.7} : null}>
        <Icon.Sparkle/> {analyzing ? 'Analyzing…' : 'AI analyze'}
      </button>

      <button className="tb-btn primary" onClick={onExport} disabled={totalCount===0}>
        <Icon.Download/> Export…
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Slider with histogram (the "delight" piece for threshold)
function HistoSlider({value, onChange, seed}){
  const bins = useMemo(()=>makeHistogram(seed), [seed]);
  return (
    <div className="slider">
      <div className="histogram">
        {bins.map((h,i)=> {
          const isCut = (i/bins.length)*100 < value;
          return <div key={i} className="bar" style={{
            height: `${4 + h*0.7}%`,
            opacity: isCut ? 0.45 : 1,
            background: isCut ? 'linear-gradient(180deg,#1a3a44,#152a30)' : undefined,
          }}/>;
        })}
      </div>
      <div className="cut" style={{left:0, width:`${value}%`}}/>
      <div className="thumb" style={{left:`${value}%`}}/>
      <input type="range" min="0" max="100" step="1" value={value}
             onChange={e=>onChange(parseInt(e.target.value,10))}/>
    </div>
  );
}

function LinearSlider({value, min=0, max=100, step=1, onChange}){
  const pct = ((value-min)/(max-min))*100;
  return (
    <div className="lslider">
      <div className="track"/>
      <div className="fill" style={{width:`${pct}%`}}/>
      <div className="knob" style={{left:`${pct}%`}}/>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={e=>onChange(parseFloat(e.target.value))}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Engine pill — shows which model is running, with status dot
function EnginePill({engineKey, status}){
  const e = ENGINES[engineKey] || ENGINES.birefnet;
  const dotColor = status === 'ready' ? 'oklch(0.62 0.13 145)'
                 : status === 'running' ? 'var(--warn)'
                 : 'var(--fg-3)';
  return (
    <div style={{
      display:'flex',alignItems:'center',gap:8,
      background:'var(--bg-2)',border:'1px solid var(--line)',
      borderRadius:7,padding:'8px 10px',
    }}>
      <span style={{
        width:7,height:7,borderRadius:'50%',background:dotColor,flexShrink:0,
        boxShadow: status==='running' ? '0 0 0 3px color-mix(in oklch, var(--warn) 30%, transparent)' : 'none',
        animation: status==='running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
      }}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:11.5,color:'var(--fg-0)',fontWeight:500,display:'flex',gap:6,alignItems:'baseline'}}>
          <span>{e.name}</span>
          <span style={{color:'var(--fg-2)',fontSize:10,fontWeight:400}} title="Download size">· {e.size} download</span>
        </div>
        <div style={{fontSize:10.5,color:'var(--fg-2)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
          {status==='running' ? 'Detecting subject…' : status==='ready' ? e.sub : 'Idle'}
        </div>
      </div>
    </div>
  );
}

// Refine brush selector — Keep / Remove + size
function RefineBrush({brush, setBrush, onResetMask, hasEdits}){
  const set = (k,v) => setBrush(b => ({...b, [k]:v}));
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
        <button className={`scope-tile ${brush.mode==='off'?'on':''}`} onClick={()=>set('mode','off')} style={{padding:'8px 8px',gap:4}}>
          <span style={{display:'inline-flex',alignItems:'center',gap:5}}><Icon.Hand size={12}/> <span className="t" style={{fontSize:11}}>Off</span></span>
          <span className="n" style={{fontSize:10}}>Pan / zoom</span>
        </button>
        <button className={`scope-tile ${brush.mode==='keep'?'on':''}`} onClick={()=>set('mode','keep')} style={{padding:'8px 8px',gap:4,borderColor: brush.mode==='keep' ? 'oklch(0.62 0.13 145)' : undefined, background: brush.mode==='keep' ? 'color-mix(in oklch, oklch(0.62 0.13 145) 14%, var(--bg-2))' : undefined}}>
          <span style={{display:'inline-flex',alignItems:'center',gap:5}}><Icon.Brush size={12}/> <span className="t" style={{fontSize:11}}>Keep</span></span>
          <span className="n" style={{fontSize:10}}>Restore subject</span>
        </button>
        <button className={`scope-tile ${brush.mode==='remove'?'on':''}`} onClick={()=>set('mode','remove')} style={{padding:'8px 8px',gap:4,borderColor: brush.mode==='remove' ? 'var(--danger)' : undefined, background: brush.mode==='remove' ? 'color-mix(in oklch, var(--danger) 14%, var(--bg-2))' : undefined}}>
          <span style={{display:'inline-flex',alignItems:'center',gap:5}}><Icon.Erase size={12}/> <span className="t" style={{fontSize:11}}>Remove</span></span>
          <span className="n" style={{fontSize:10}}>Erase leaks</span>
        </button>
      </div>

      <div className="field" style={{marginBottom:0,opacity: brush.mode==='off' ? .45 : 1, transition:'opacity .15s'}}>
        <div className="field-h">
          <span>Brush size</span>
          <span className="mono field-v">{Math.round(brush.size)}px</span>
        </div>
        <LinearSlider value={brush.size} min={10} max={100} step={1} onChange={v=>set('size',Math.max(10, Math.min(100, Math.round(v))))}/>
      </div>

      {hasEdits && (
        <button className="reset" onClick={onResetMask} style={{alignSelf:'flex-start',fontSize:10,letterSpacing:'.04em',textTransform:'uppercase',background:'transparent',border:'1px solid var(--line-2)',color:'var(--fg-2)',padding:'4px 8px',borderRadius:5,cursor:'default',display:'inline-flex',alignItems:'center',gap:4}}>
          <Icon.Reset size={11}/> Clear refinements
        </button>
      )}

      <div className="field-help" style={{margin:0}}>
        Paint over areas the model got wrong. <kbd>[</kbd> <kbd>]</kbd> to resize, <kbd>X</kbd> to swap.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// Seed-color chip — shows the hex of a sampled background color
function SeedChip({color, onRemove}){
  const hex = '#' + [color.r, color.g, color.b].map(n => n.toString(16).padStart(2,'0')).join('').toUpperCase();
  return (
    <div className="mono" title={hex} style={{
      display:'inline-flex',alignItems:'center',gap:6,padding:'4px 6px 4px 5px',
      background:'#fff',border:'1px solid var(--line)',borderRadius:6,
      fontSize:11,color:'var(--fg-0)',
    }}>
      <span style={{
        width:14,height:14,borderRadius:3,
        background:`rgb(${color.r},${color.g},${color.b})`,
        border:'1px solid rgba(0,0,0,.18)',
        flexShrink:0,
      }}/>
      <span>{hex}</span>
      {onRemove && (
        <button onClick={(e)=>{e.stopPropagation(); onRemove();}} style={{
          border:0,background:'transparent',color:'var(--fg-2)',
          width:14,height:14,borderRadius:3,cursor:'default',padding:0,
          display:'inline-flex',alignItems:'center',justifyContent:'center',marginLeft:1,
        }}>
          <Icon.Close size={9}/>
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal guided detection — v6: dropped Tap & Scribble. Box detection is
// reliable enough that the only inputs the user needs are (a) drag a box
// around the subject and (b) paint over interior pixels they want to keep.
function GuidedPanel({mode, setMode, seeds, setSeeds, commitSeeds, onClearSeeds, hasImage}){
  const boxesArr = (seeds.boxes && seeds.boxes.length) ? seeds.boxes : (seeds.box ? [seeds.box] : []);
  const counts = {
    boxes: boxesArr.length,
    protectStrokes: (seeds.protectStrokes || []).length,
    bgSamples: (seeds.bgSamples || []).length,
    eraseStrokes: (seeds.eraseStrokes || []).length,
  };
  const totalSeeds = counts.boxes + counts.protectStrokes + counts.bgSamples + counts.eraseStrokes;

  const Tab = ({id, icon, label}) => (
    <button onClick={()=>setMode(id)}
      style={{
        flex:1,height:34,borderRadius:6,cursor:'default',padding:'0 6px',
        border:`1px solid ${mode===id?'var(--primary)':'var(--line)'}`,
        background: mode===id ? 'var(--primary)' : '#fff',
        color: mode===id ? 'var(--primary-fg)' : 'var(--fg-1)',
        display:'inline-flex',alignItems:'center',justifyContent:'center',gap:5,
        fontSize:11,fontWeight: mode===id?600:500,
        boxShadow: mode===id ? '0 1px 0 rgba(255,255,255,.12) inset, 0 1px 2px rgba(0,0,0,.18)' : 'none',
      }}>
      {icon}<span>{label}</span>
    </button>
  );

  return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      <div className="field-help" style={{margin:0}}>
        Box the subject, sample background tones to remove, and paint to restore pixels that should stay.
      </div>

      <div style={{display:'flex',gap:5}}>
        <Tab id="sample"  icon={<Icon.Pipette size={12}/>} label="Sample"/>
        <Tab id="protect" icon={<Icon.Shield size={12}/>} label="Restore"/>
      </div>

      {/* Sample sub-tool — two input form factors for marking what to remove.
          Click samples a color (removed everywhere); Paintbrush erases the
          exact region you paint, regardless of color. Same segmented control
          (.seg tablist) used by the Single | Contact sheet toggle. */}
      {mode === 'sample' && (() => {
        const tool = seeds.sampleTool ?? 'click';
        return (
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <div className="seg" role="tablist" aria-label="Sample tool" style={{width:'100%'}}>
              <button role="tab" aria-selected={tool==='click'} className={tool==='click'?'on':''}
                style={{flex:1,justifyContent:'center'}}
                onClick={()=>setSeeds(s=>({...s, sampleTool:'click'}))}>
                <Icon.Cursor size={13}/> Click
              </button>
              <button role="tab" aria-selected={tool==='paint'} className={tool==='paint'?'on':''}
                style={{flex:1,justifyContent:'center'}}
                onClick={()=>setSeeds(s=>({...s, sampleTool:'paint'}))}>
                <Icon.Brush size={13}/> Paintbrush
              </button>
            </div>
            {tool === 'paint' && (
              <div className="field" style={{marginBottom:0}}>
                <div className="field-h">
                  <span>Brush size</span>
                  <span className="mono field-v">{Math.round(seeds.eraseBrushSize ?? 60)}px</span>
                </div>
                <LinearSlider
                  value={seeds.eraseBrushSize ?? 60}
                  min={8} max={400} step={1}
                  onChange={v=>setSeeds(s=>({...s, eraseBrushSize: Math.max(8, Math.min(400, Math.round(v)))}))}/>
              </div>
            )}
          </div>
        );
      })()}

      {/* Status surface — shows the box, refine pins, and any protect strokes */}
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
          <span style={{fontSize:10.5,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--fg-2)',fontWeight:600}}>Selection</span>
          {totalSeeds > 0 && (
            <button onClick={onClearSeeds} style={{
              border:0,background:'transparent',color:'var(--fg-2)',fontSize:10,letterSpacing:'.04em',textTransform:'uppercase',
              padding:'2px 4px',borderRadius:4,cursor:'default',display:'inline-flex',alignItems:'center',gap:3,
            }}>
              <Icon.Reset size={10}/> Clear
            </button>
          )}
        </div>

        {counts.boxes === 0 && counts.protectStrokes === 0 && counts.bgSamples === 0 && counts.eraseStrokes === 0 ? (

          <div style={{
            padding:'12px 10px',border:'1px dashed var(--line-2)',borderRadius:6,
            color:'var(--fg-2)',fontSize:11,textAlign:'center',background:'#fff',
          }}>
            {hasImage
              ? (mode === 'protect'
                  ? 'Paint over interior subject pixels you want to keep, no matter what.'
                  : mode === 'sample'
                  ? ((seeds.sampleTool ?? 'click') === 'paint'
                      ? 'Paint over the areas you want to make transparent — the brushed pixels are erased directly, whatever their color.'
                      : 'Click anywhere on a background color (purple, wood, etc.) to remove it. Click multiple background tones to handle mixed backgrounds.')
                  : 'Drag a box around the subject.')
              : 'Load an image to begin.'}
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {counts.boxes > 0 && (
                <span className="mono" style={{
                  display:'inline-flex',alignItems:'center',gap:6,padding:'4px 8px',
                  background:'#fff',border:'1px solid var(--line)',borderRadius:6,fontSize:11,color:'var(--fg-1)',
                }}>
                  <span style={{width:10,height:10,borderRadius:2,border:'1.5px solid var(--primary)'}}/>
                  {counts.boxes} {counts.boxes === 1 ? 'box' : 'boxes'}
                </span>
              )}
              {counts.protectStrokes > 0 && (
                <span className="mono" style={{
                  display:'inline-flex',alignItems:'center',gap:6,padding:'4px 8px',
                  background:'#fff',border:'1px solid oklch(0.62 0.13 145)',borderRadius:6,fontSize:11,color:'var(--fg-1)',
                }}>
                  <Icon.Shield size={10}/>
                  {counts.protectStrokes} protected
                </span>
              )}
              {counts.bgSamples > 0 && (
                <span className="mono" style={{
                  display:'inline-flex',alignItems:'center',gap:6,padding:'4px 8px',
                  background:'#fff',border:'1px solid var(--line)',borderRadius:6,fontSize:11,color:'var(--fg-1)',
                }}>
                  <Icon.Pipette size={10}/>
                  {counts.bgSamples} sampled
                </span>
              )}
              {counts.eraseStrokes > 0 && (
                <span className="mono" style={{
                  display:'inline-flex',alignItems:'center',gap:6,padding:'4px 8px',
                  background:'#fff',border:'1px solid oklch(0.55 0.18 28)',borderRadius:6,fontSize:11,color:'var(--fg-1)',
                }}>
                  <Icon.Brush size={10}/>
                  {counts.eraseStrokes} erased
                </span>
              )}
            </div>
            {counts.bgSamples > 0 && (
              <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                {(seeds.bgSamples || []).map((c, i) => (
                  <SeedChip key={i} color={c}
                    onRemove={() => (commitSeeds || setSeeds)(s => ({
                      ...s,
                      bgSamples: (s.bgSamples || []).filter((_, j) => j !== i),
                    }))}/>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Protect-mode brush size control */}
      {mode === 'protect' && (
        <div className="field" style={{marginBottom:0}}>
          <div className="field-h">
            <span>Brush size</span>
            <span className="mono field-v">{Math.round(seeds.protectBrushSize ?? 100)}px</span>
          </div>
          <LinearSlider
            value={seeds.protectBrushSize ?? 100}
            min={8} max={500} step={1}
            onChange={v=>setSeeds(s=>({...s, protectBrushSize: Math.max(8, Math.min(500, Math.round(v)))}))}/>
        </div>
      )}

      <div className="field-help" style={{margin:0}}>
        {mode === 'box' && (counts.boxes > 0
          ? <>Drag another rectangle to add more background seeds.</>
          : <>Drag a rectangle around the subject.</>)}
        {mode === 'sample' && (seeds.sampleTool ?? 'click') === 'paint' && <>Paint over what should become transparent. <kbd>[</kbd> <kbd>]</kbd> or scroll to resize the brush.</>}
        {mode === 'protect' && <>Paint subject pixels that must stay opaque. <kbd>[</kbd> <kbd>]</kbd> to resize. The cutout will never erase these.</>}
      </div>
    </div>
  );
}

// Undo / Redo / Undo All action bar — pinned to the bottom of the Cutout
// panel. The cutout is auto-kept after every edit, so there's no manual Keep:
// Undo steps back through the last action, Redo re-applies it, and Undo All
// restores the image to its original, untouched state. Distinct from Export,
// which writes files to disk.
function CutoutActions({canUndo, canRedo, hasAny, onUndo, onRedo, onUndoAll}){
  const Btn = ({onClick, disabled, icon, label, title, danger}) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="tb-btn ghost"
      style={{
        flex:1,height:32,justifyContent:'center',
        color: danger ? 'var(--danger)' : 'var(--fg-1)',
        opacity: disabled ? 0.4 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
      title={title}>
      {icon} {label}
    </button>
  );
  return (
    <div style={{
      borderTop:'1px solid var(--line)',
      padding:'12px 14px',
      background:'#fff',
      display:'flex',gap:8,
    }}>
      <Btn onClick={onUndo} disabled={!canUndo} icon={<Icon.Undo size={12}/>}
           label="Undo" title="Undo last action (⌘Z)"/>
      <Btn onClick={onRedo} disabled={!canRedo} icon={<Icon.Redo size={12}/>}
           label="Redo" title="Redo last action (⇧⌘Z)"/>
      <Btn onClick={onUndoAll} disabled={!hasAny && !canUndo} icon={<Icon.Reset size={12}/>}
           label="Undo All" title="Restore the original image" danger/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Left controls panel — v4 stripped to the essentials
function ControlsPanel({activeImage, guidedMode, setGuidedMode, seeds, setSeeds, commitSeeds, onClearSeeds, canUndo, canRedo, onUndo, onRedo, onUndoAll}){
  const hasSeeds = !!(
    (seeds.boxes && seeds.boxes.length) ||
    seeds.box ||
    (seeds.protectStrokes && seeds.protectStrokes.length) ||
    (seeds.bgSamples && seeds.bgSamples.length) ||
    (seeds.eraseStrokes && seeds.eraseStrokes.length)
  );
  return (
    <div className="panel-l">
      <div className="panel-l-head">
        <div className="panel-l-title">Cutout</div>
      </div>

      <div className="panel-l-body nice-scroll" style={{padding:'14px 14px 14px'}}>
        <GuidedPanel
          mode={guidedMode} setMode={setGuidedMode}
          seeds={seeds} setSeeds={setSeeds} commitSeeds={commitSeeds}
          onClearSeeds={onClearSeeds}
          hasImage={!!activeImage}
        />
      </div>

      {!!activeImage && (
        <CutoutActions
          canUndo={canUndo}
          canRedo={canRedo}
          hasAny={hasSeeds}
          onUndo={onUndo}
          onRedo={onRedo}
          onUndoAll={onUndoAll}
        />
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// Right rail (filmstrip)
function Filmstrip({images, activeId, selectedIds, onSelect, onActivate, thumbSize, search, setSearch, onLoadFiles, onLoadFolder, onClearReal, hidden}){
  const filtered = images.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()));
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const realCount = images.filter(i => i.real).length;

  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    if(files.length) onLoadFiles(files);
    e.target.value = '';
  };
  const onPickFolder = (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    if(files.length) onLoadFolder(files);
    e.target.value = '';
  };
  const onDrop = (e) => {
    e.preventDefault();
    const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const files = [];
    for(const it of items){
      if(it.kind === 'file'){
        const f = it.getAsFile();
        if(f && f.type.startsWith('image/')) files.push(f);
      }
    }
    if(!files.length){
      const fl = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
      files.push(...fl);
    }
    if(files.length) onLoadFiles(files);
  };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };

  if(hidden) return null;
  return (
    <div className="panel-r" onDragOver={onDragOver} onDrop={onDrop}>
      <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:'none'}} onChange={onPickFiles}/>
      <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple style={{display:'none'}} onChange={onPickFolder}/>
      <div className="panel-r-head" style={{flexDirection:'column',alignItems:'stretch',gap:8,padding:'10px 10px 10px'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6}}>
          <span className="panel-r-title">{images.length} images{realCount > 0 ? ` · ${realCount} real` : ''}</span>
          {realCount > 0 && (
            <button className="reset" style={{fontSize:10,letterSpacing:'.04em',textTransform:'uppercase',background:'transparent',border:'1px solid var(--line-2)',color:'var(--fg-2)',padding:'2px 6px',borderRadius:4,cursor:'default'}}
                    onClick={onClearReal} title="Clear loaded files">Clear</button>
          )}
        </div>
        <div style={{display:'flex',gap:6}}>
          <button className="tb-btn ghost" style={{flex:1,height:28,justifyContent:'center',fontSize:11,padding:'0 6px'}}
                  onClick={()=>folderInputRef.current?.click()}>
            <Icon.Folder size={12}/> Folder
          </button>
          <button className="tb-btn ghost" style={{flex:1,height:28,justifyContent:'center',fontSize:11,padding:'0 6px'}}
                  onClick={()=>fileInputRef.current?.click()}>
            <Icon.Image size={12}/> Files
          </button>
        </div>
      </div>
      <div className="panel-r-body nice-scroll">
        {filtered.map(img => {
          const sel = selectedIds.has(img.id);
          const act = activeId === img.id;
          return (
            <div key={img.id}
                 className={`thumb ${sel?'selected':''} ${act?'active':''} ${img.processed?'processed':''}`}
                 onClick={(e)=>onSelect(img.id, e)}
                 onDoubleClick={()=>onActivate(img.id)}
                 style={{width:'100%'}}>
              <div className="img" style={{
                aspectRatio:'1/1',
                position:'relative',
                height: thumbSize,
                backgroundColor: img.processed && img.cutoutDataUrl ? '#ffffff' : '#fbf8f1',
                backgroundImage: img.processed && img.cutoutDataUrl
                  ? `url("${img.cutoutDataUrl}"), linear-gradient(45deg,#f3ecdd 25%,transparent 25%),linear-gradient(-45deg,#f3ecdd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f3ecdd 75%),linear-gradient(-45deg,transparent 75%,#f3ecdd 75%)`
                  : `url("${img.original}")`,
                backgroundSize: img.processed && img.cutoutDataUrl
                  ? `contain, 16px 16px, 16px 16px, 16px 16px, 16px 16px`
                  : 'cover',
                backgroundPosition: img.processed && img.cutoutDataUrl
                  ? `center, 0 0, 0 8px, 8px -8px, -8px 0`
                  : 'center',
                backgroundRepeat: img.processed && img.cutoutDataUrl
                  ? 'no-repeat, repeat, repeat, repeat, repeat'
                  : 'no-repeat',
              }}/>
              <div className="corner">
                {img.processed && <span className="pill ok">Cutout</span>}
                {!img.processed && sel && <span className="pill">Queued</span>}
              </div>
              <div className="meta">
                <span className="name mono">{img.name}.{img.ext || 'jpg'}</span>
                <span className="badge">{img.processed ? '✓' : ''}</span>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{color:'var(--fg-2)',fontSize:11,textAlign:'center',padding:'24px 8px'}}>
            No images match “{search}”
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Single canvas with zoom/pan + click toggle
function SingleCanvas({image, s, zoom, setZoom, pan, setPan, onClickToggle, peekOriginal, brush, setBrush, guidedMode='off', seeds, setSeeds, pushHistory, fitKey, onFit, showOrigClick}){
  const ref = useRef(null);
  const stageRef = useRef(null);
  // Natural image dimensions — used to compute the Fit-to-pane base size so
  // non-square images aren't cropped or letter-boxed inside a fixed square frame.
  const [imgDims, setImgDims] = useState(null);
  useEffect(() => {
    if(!image?.original){ setImgDims(null); return; }
    const im = new Image();
    im.onload = () => setImgDims({w: im.naturalWidth || 1, h: im.naturalHeight || 1});
    im.src = image.original;
  }, [image?.id, image?.original]);
  const [matteAnimKey, setMatteAnimKey] = useState(0);
  const [cursorPos, setCursorPos] = useState(null);
  const prevMatte = useRef(s.matte);
  // Protect layer: the masked-image overlay is expensive to render (large
  // SVG mask, full-image filter pipeline). Painting feedback comes from the
  // brush-cursor outline alone; the actual protected pixels reveal 1s after
  // the user finishes a stroke. Restored from v6 behavior — v8/v9 had it
  // rendering live which made painting laggy.
  const isDrawingProtect = seeds?.drawing?.kind === 'protect';
  const [protectVisible, setProtectVisible] = useState(true);
  const protectStrokesLen = (seeds?.protectStrokes || []).length;
  useEffect(() => {
    if(isDrawingProtect){ setProtectVisible(false); return; }
    setProtectVisible(false);
    const t = setTimeout(() => setProtectVisible(true), 1000);
    return () => clearTimeout(t);
  }, [protectStrokesLen, isDrawingProtect]);
  // Hidden canvas used to sample real pixel colors (now only for derived box/border samples).
  const sampleCanvasRef = useRef(null);
  useEffect(()=>{
    if(!image?.original) return;
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth || 256; c.height = im.naturalHeight || 256;
      const ctx = c.getContext('2d');
      try { ctx.drawImage(im, 0, 0); sampleCanvasRef.current = c; }
      catch(e){ sampleCanvasRef.current = null; }
    };
    im.src = image.original;
  }, [image?.id, image?.original]);

  useEffect(()=>{
    if(prevMatte.current !== s.matte){ setMatteAnimKey(k=>k+1); prevMatte.current = s.matte; }
  }, [s.matte]);

  const guiding = guidedMode === 'box' || guidedMode === 'protect' || guidedMode === 'sample';
  const protecting = guidedMode === 'protect';
  const sampling = guidedMode === 'sample';
  const samplePainting = sampling && (seeds?.sampleTool === 'paint');
  const brushing = !guiding && (brush?.mode === 'keep' || brush?.mode === 'remove');

  // Wheel zoom + pan
  const onWheel = (e) => {
    e.preventDefault();
    if(e.ctrlKey || e.metaKey){
      const d = -e.deltaY * 0.0025;
      setZoom(z => Math.max(0.1, Math.min(8, z * (1 + d))));
    } else if (brushing) {
      setBrush?.(b => ({...b, size: Math.max(10, Math.min(100, Math.round(b.size - e.deltaY * 0.05)))}));
    } else if (samplePainting) {
      // wheel resizes the sample paintbrush ([ / ] also work)
      setSeeds?.(s => ({...s, eraseBrushSize: Math.max(8, Math.min(400, Math.round((s.eraseBrushSize ?? 60) - e.deltaY * 0.25)))}));
    } else if (protecting) {
      // [/] keys also work; wheel resizes the protect brush
      setSeeds?.(s => ({...s, protectBrushSize: Math.max(8, Math.min(500, Math.round((s.protectBrushSize ?? 100) - e.deltaY * 0.25)))}));
    } else if (guiding) {
      // don't scroll out of the seeded image
      setPan(p => ({x: p.x - e.deltaX*0.4, y: p.y - e.deltaY*0.4}));
    } else {
      setPan(p => ({x: p.x - e.deltaX, y: p.y - e.deltaY}));
    }
  };

  // Convert pointer event → image-relative coords (0..1) on the stage frame
  const stageBaseRef = useRef(null);
  const stageCoords = (e) => {
    const el = stageBaseRef.current;
    if(!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top)  / r.height,
    };
  };

  const samplePixel = (u, v) => {
    const c = sampleCanvasRef.current;
    if(!c) return null;
    const x = Math.max(0, Math.min(c.width-1, Math.floor(u * c.width)));
    const y = Math.max(0, Math.min(c.height-1, Math.floor(v * c.height)));
    try {
      const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
      return {r:d[0], g:d[1], b:d[2]};
    } catch(e){ return null; }
  };

  // Snapshot of committed seeds captured at the start of a drag gesture, so the
  // whole stroke/box collapses into a single undo step on release.
  const gestureSnapshotRef = useRef(null);

  // Click-sample the single pixel under the cursor and add it to bgSamples
  // (exact-match dedup — a deliberately-picked tone is always honored). The
  // paintbrush is NOT a color sampler; it paints spatial erase strokes below.
  const addSampleAt = (u, v) => {
    const c = samplePixel(u, v);
    if(!c) return;
    setSeeds(st => {
      const existing = st.bgSamples || [];
      if(existing.some(e => e.r === c.r && e.g === c.g && e.b === c.b)) return st;
      return {...st, bgSamples: [...existing, c]};
    });
  };

  // Drag pan + guided drawing
  const dragRef = useRef(null);
  const onMouseDown = (e) => {
    if(e.button !== 0) return;
    // Shift+drag (or middle-click) always pans, regardless of mode.
    // This lets users reposition the canvas while in Box / Protect / Sample
    // / brush modes without having to toggle modes.
    if(e.shiftKey){
      dragRef.current = {sx:e.clientX, sy:e.clientY, px:pan.x, py:pan.y, moved:false, kind:'shift-pan'};
      return;
    }
    if(guiding){
      const p = stageCoords(e); if(!p) return;
      // sample tab: two input form factors for "what to make transparent".
      //  · Click    → sample the color under the cursor (removes it everywhere)
      //  · Paintbrush → paint a spatial erase stroke (those pixels go transparent
      //                 regardless of color — the whole stroke is one undo step)
      if(guidedMode === 'sample'){
        gestureSnapshotRef.current = {...seeds, drawing:null};
        if(seeds?.sampleTool === 'paint'){
          const size = seeds.eraseBrushSize ?? 60;
          setSeeds(s=>({...s, drawing:{kind:'erase', size, points:[p]}}));
          dragRef.current = {kind:'guided-erase', moved:true};
        } else {
          addSampleAt(p.x, p.y);
          dragRef.current = {kind:'guided-sample', moved:false};
        }
        return;
      }
      // protect: start a new protect stroke
      if(guidedMode === 'protect'){
        gestureSnapshotRef.current = {...seeds, drawing:null};
        const size = seeds.protectBrushSize ?? 100;
        setSeeds(s=>({...s, drawing:{kind:'protect', size, points:[p]}}));
        dragRef.current = {kind:'guided-protect', moved:true};
        return;
      }
      // box drag start — every drag adds another box (additive seeds)
      if(guidedMode === 'box'){
        gestureSnapshotRef.current = {...seeds, drawing:null};
        setSeeds(s=>({...s, drawing:{kind:'box', startX:p.x, startY:p.y, x:p.x, y:p.y, w:0, h:0}}));
        dragRef.current = {kind:'guided-box', startX:e.clientX, startY:e.clientY, moved:false};
        return;
      }

    }
    // Non-guided / non-brushing left-drag is a no-op (the click-toggle
    // happens on mouseup if there was no movement). Pan is now exclusively
    // Shift+drag — handled at the top of this function.
  };
  const onMouseMove = (e) => {
    // record cursor pos relative to canvas-wrap (used for brush cursor + protect brush)
    if(brushing || guiding){
      const r = e.currentTarget.getBoundingClientRect();
      setCursorPos({x:e.clientX - r.left, y:e.clientY - r.top});
    }
    if(dragRef.current?.kind === 'guided-box'){
      const p = stageCoords(e); if(!p) return;
      const sx = Math.min(seeds.drawing.startX, p.x);
      const sy = Math.min(seeds.drawing.startY, p.y);
      const w  = Math.abs(p.x - seeds.drawing.startX);
      const h  = Math.abs(p.y - seeds.drawing.startY);
      dragRef.current.moved = w > 0.01 || h > 0.01;
      setSeeds(st=>({...st, drawing:{...st.drawing, x:sx, y:sy, w, h}}));
      return;
    }
    if(dragRef.current?.kind === 'guided-protect'){
      const p = stageCoords(e); if(!p) return;
      setSeeds(st=>({...st, drawing:{...st.drawing, points:[...st.drawing.points, p]}}));
      return;
    }
    if(dragRef.current?.kind === 'guided-erase'){
      const p = stageCoords(e); if(!p) return;
      setSeeds(st=>({...st, drawing:{...st.drawing, points:[...st.drawing.points, p]}}));
      return;
    }
    if(dragRef.current && (!dragRef.current.kind || dragRef.current.kind === 'shift-pan')){
      const dx = e.clientX - dragRef.current.sx;
      const dy = e.clientY - dragRef.current.sy;
      if(Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.moved = true;
      setPan({x: dragRef.current.px + dx, y: dragRef.current.py + dy});
    }
  };
  const onMouseUp = (e) => {
    if(dragRef.current?.kind === 'guided-box'){
      // commit box if it has area — append to boxes array
      const d = seeds.drawing;
      if(d && d.w > 0.02 && d.h > 0.02) pushHistory?.(gestureSnapshotRef.current);
      setSeeds(st=>{
        const dd = st.drawing;
        if(dd && dd.w > 0.02 && dd.h > 0.02){
          const newBox = {x:dd.x, y:dd.y, w:dd.w, h:dd.h};
          const existing = (st.boxes && st.boxes.length) ? st.boxes : (st.box ? [st.box] : []);
          return {...st, boxes:[...existing, newBox], box:null, drawing:null};
        }
        return {...st, drawing:null};
      });
      dragRef.current = null;
      return;
    }
    if(dragRef.current?.kind === 'guided-protect'){
      if(seeds.drawing?.points?.length >= 1) pushHistory?.(gestureSnapshotRef.current);
      setSeeds(st=>{
        const d = st.drawing;
        if(d && d.points && d.points.length >= 1){
          return {...st, protectStrokes:[...(st.protectStrokes||[]), {size:d.size, points:d.points}], drawing:null};
        }
        return {...st, drawing:null};
      });
      dragRef.current = null;
      return;
    }
    if(dragRef.current?.kind === 'guided-erase'){
      // Commit the erase stroke (paint → transparent). One undo step per stroke.
      if(seeds.drawing?.points?.length >= 1) pushHistory?.(gestureSnapshotRef.current);
      setSeeds(st=>{
        const d = st.drawing;
        if(d && d.points && d.points.length >= 1){
          return {...st, eraseStrokes:[...(st.eraseStrokes||[]), {size:d.size, points:d.points}], drawing:null};
        }
        return {...st, drawing:null};
      });
      dragRef.current = null;
      return;
    }
    if(dragRef.current?.kind === 'guided-sample'){
      // One undo step per click — only if it actually added a new color.
      const before = gestureSnapshotRef.current?.bgSamples?.length || 0;
      const after = seeds.bgSamples?.length || 0;
      if(after !== before) pushHistory?.(gestureSnapshotRef.current);
      dragRef.current = null;
      return;
    }
    dragRef.current = null;
  };

  const onCanvasClick = (e) => {
    if(dragRef.current?.moved) return;
    // Box mode: a click without a drag is a no-op. Box seeds are added by
    // dragging out additional rectangles on mouseDown/Move/Up.
    if(guiding) return;
    if(!brushing) onClickToggle();
  };

  if(!image) return null;

  const brushColor = brush?.mode === 'keep' ? 'oklch(0.62 0.13 145)' : 'oklch(0.55 0.18 28)';

  // v6 — only Box drives the live cutout (Tap & Scribble were removed). The
  // box describes a region around the subject; we sample colors from outside
  // it (the corners) to seed the SVG filter. Memoised on the inputs so we
  // don't resample every frame.
  const effectiveSeedColors = useMemo(() => {
    const out = [];
    // Exact-match dedupe only — user-picked samples should always be honored,
    // even if visually similar to another. The previous 32-step bucket was
    // double-trouble: it ran on top of the click-time dedupe and could drop
    // user picks the click handler had already accepted.
    const exactKey = (c) => `${c.r},${c.g},${c.b}`;
    const seen = new Set();
    const push = (c) => {
      if(!c) return;
      const k = exactKey(c);
      if(seen.has(k)) return;
      seen.add(k);
      out.push(c);
    };
    // user-picked background colors take priority — multi-sample erase for
    // mixed/two-tone backgrounds (purple paper + wood, etc.)
    for(const c of (seeds?.bgSamples || [])){
      push(c);
      if(out.length >= 8) break;
    }
    // sample around the box perimeter (outside = background).
    // v5 fix: only sample a COMMITTED box. We used to fall through to
    // seeds.drawing, which fired the cutout on every mousemove while the
    // user was still drawing — flickering preview and a confusing UX.
    // Wait for mouseup so all 4–6 seed points come in at once.
    const boxes = (seeds?.boxes && seeds.boxes.length) ? seeds.boxes
      : (seeds?.box ? [seeds.box] : []);
    if(boxes.length && out.length < 8){
      const inAnyBox = (x, y) => boxes.some(b => x >= b.x && x <= b.x+b.w && y >= b.y && y <= b.y+b.h);
      // grab a handful of points from the four corners of the canvas — those
      // are the most reliable "background" pixels when the user has framed a subject
      const probes = [
        {x:0.02, y:0.02}, {x:0.98, y:0.02},
        {x:0.02, y:0.98}, {x:0.98, y:0.98},
        {x:0.5,  y:0.02}, {x:0.5,  y:0.98},
      ].filter(p => !inAnyBox(p.x, p.y));
      for(const p of probes){
        push(samplePixel(p.x, p.y));
        if(out.length >= 8) break;
      }
    }
    return out.slice(0, 8);
  // samplePixel reads from a canvas ref, so re-derive whenever the seeds change
  // or the active image changes (image.original triggers a new sample canvas).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeds?.boxes, seeds?.box, seeds?.drawing, seeds?.bgSamples, image?.original]);

  // Cutout shows when there are seed colors OR erase strokes (a spatial-only
  // erase needs no sampled color).
  const hasSeeds = effectiveSeedColors.length > 0 || (seeds?.eraseStrokes?.length > 0);
  const showCutout = !s.showOriginal && !peekOriginal && hasSeeds;
  const cutoutUri = typeof image.cutout === 'function' ? image.cutout(s.threshold, s.feather) : image.original;

  // v12 — Live canvas-based cutout. Replaces the previous SVG-filter chain
  // (feColorMatrix + V-curve + multi-seed feComposite). The SVG version was
  // unreliable past 2 seeds because chained feComposite primitives accumulate
  // precision/clamping errors across iterations — additional sampled hex
  // colors visibly stopped contributing to the erase. The rasterizer code
  // (used at Keep/Export) computes pixel-accurate min-RGB-distance against
  // every seed, so we lift that here for the live preview too. Keys on
  // image+seeds+tolerance and runs async so painting/click latency is fine.
  const [liveCutoutUrl, setLiveCutoutUrl] = useState(null);
  const seedSig = useMemo(() => effectiveSeedColors.map(c => `${c.r},${c.g},${c.b}`).join('|'),
                          [effectiveSeedColors]);
  // Signature for protect strokes — recompute the live cutout when strokes
  // change (or their points/sizes change). Cheap to compute.
  const strokeSig = (arr) => (arr || []).map(s => `${s.size}:${(s.points||[]).length}:${(s.points||[]).map(p=>`${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';')}`).join('|');
  const protectSig = useMemo(() => strokeSig(seeds?.protectStrokes), [seeds?.protectStrokes]);
  const eraseSig = useMemo(() => strokeSig(seeds?.eraseStrokes), [seeds?.eraseStrokes]);
  useEffect(() => {
    if(!image?.original || !showCutout || !sampleCanvasRef.current) {
      setLiveCutoutUrl(null);
      return;
    }
    let cancelled = false;
    const src = sampleCanvasRef.current;
    const W = src.width, H = src.height;
    // Cap working size for snappy live preview; output is just for screen.
    const MAX = 1200;
    const scale = Math.min(1, MAX / Math.max(W, H));
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    let imgData;
    try { imgData = ctx.getImageData(0, 0, w, h); }
    catch(e) { setLiveCutoutUrl(null); return; }
    const data = imgData.data;

    const tolerance = (seeds?.tolerance ?? 32);
    const t = Math.max(2, tolerance) / 100;
    const radius = t * 0.55 * 255 * Math.sqrt(3);
    const softness = radius * 0.35;
    const lo = radius - softness;
    const hi = radius + softness;
    const range = Math.max(1, hi - lo);

    const seedColors = effectiveSeedColors;
    const eraseStrokes = (seeds?.eraseStrokes || []);
    if(seedColors.length === 0 && eraseStrokes.length === 0){
      // No-op — we shouldn't even reach here because showCutout requires hasSeeds.
      setLiveCutoutUrl(null);
      return;
    }

    // Brush masks in the downscaled (w × h) working space — `size` is in
    // image-natural px, so radiusScale = w / W. Protect = keep opaque (single
    // source of truth, no overlay layer); Erase = force transparent regardless
    // of color (a direct spatial eraser, mirror of the protect brush).
    const radiusScale = w / W;
    const protectMask = strokesToMask(seeds?.protectStrokes, w, h, radiusScale);
    const eraseMask   = strokesToMask(eraseStrokes,          w, h, radiusScale);
    const hasColor = seedColors.length > 0;

    for(let i = 0; i < data.length; i += 4){
      if(protectMask && protectMask[i] > 128){ data[i+3] = 255; continue; } // protect → opaque
      if(eraseMask && eraseMask[i] > 128){ data[i+3] = 0; continue; }       // erase → transparent
      if(!hasColor){ continue; }  // erase-only image: everything else stays opaque
      const r = data[i], g = data[i+1], b = data[i+2];
      let best = Infinity;
      for(const c of seedColors){
        const dr = r - c.r, dg = g - c.g, db = b - c.b;
        const d2 = dr*dr + dg*dg + db*db;
        if(d2 < best){ best = d2; if(best === 0) break; }
      }
      const dist = Math.sqrt(best);
      let a;
      if(dist <= lo) a = 0;
      else if(dist >= hi) a = 255;
      else a = Math.round(((dist - lo) / range) * 255);
      data[i+3] = a;
    }
    ctx.putImageData(imgData, 0, 0);
    out.toBlob(blob => {
      if(cancelled || !blob) return;
      const url = URL.createObjectURL(blob);
      setLiveCutoutUrl(prev => {
        if(prev) URL.revokeObjectURL(prev);
        return url;
      });
    }, 'image/png');
    return () => { cancelled = true; };
  }, [image?.id, image?.original, seedSig, seeds?.tolerance, showCutout, protectSig, eraseSig]);
  // Revoke on unmount
  useEffect(() => () => { if(liveCutoutUrl) URL.revokeObjectURL(liveCutoutUrl); }, []);
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  const cursor = 'grab';

  // Live preview math driven by sliders. These map to SVG filter primitives so
  // moving the sliders has a visible effect even without a real segmentation engine.
  // threshold: luminance below this value becomes transparent
  // feather:   gaussian blur radius applied to the matte (soft edges)
  // smooth:    additional blur on the source before thresholding (denoise)
  // edge:      morphological erode/dilate of the matte
  const tNorm = s.threshold / 100;                // 0..1 luminance cutoff
  const tSlope = 12 + s.smooth * 0.4;             // higher smoothing → softer transition
  const featherStdDev = Math.max(0.01, s.feather * 0.35);
  const erode = s.edge < 0 ? Math.abs(s.edge) * 0.4 : 0;
  const dilate = s.edge > 0 ? s.edge * 0.4 : 0;
  const filterId = 'cutter-fx';

  // base size — compute Fit-to-pane bounds from the canvas-wrap dimensions
  // and the image's natural aspect ratio. Falls back to a square 640px frame
  // until the image has loaded. Margin keeps a comfortable border around the
  // image so cutout shadows + status banners aren't crowding the edges.
  const [stageDims, setStageDims] = useState({w: 1000, h: 700});
  useEffect(() => {
    const el = ref.current;
    if(!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStageDims({w: r.width || 1000, h: r.height || 700});
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitMargin = 40;
  const aspect = imgDims ? (imgDims.w / imgDims.h) : 1;
  const availW = Math.max(120, stageDims.w - fitMargin * 2);
  const availH = Math.max(120, stageDims.h - fitMargin * 2);
  // Pick the larger of (fit-by-width, fit-by-height) so the frame is as big
  // as it can be while still respecting both axes.
  let baseW = availW, baseH = availW / aspect;
  if(baseH > availH){ baseH = availH; baseW = availH * aspect; }
  const base = baseW;        // legacy var name; used for protect-stroke radius math
  const baseHeight = baseH;

  return (
    <div ref={ref} className="canvas-wrap"
         onWheel={onWheel}
         onMouseDown={onMouseDown}
         onMouseMove={onMouseMove}
         onMouseUp={onMouseUp}
         onMouseLeave={(e)=>{ onMouseUp(e); setCursorPos(null); }}
         style={{cursor: brushing ? 'none' : protecting ? 'none' : samplePainting ? 'none' : guiding ? 'crosshair' : cursor}}
         onClick={onCanvasClick}>

      <div className="stage">
        <div ref={stageBaseRef} className="stage-frame" style={{width:base, height:baseHeight, transform}}>
          {/* SVG filter that drives the live cutout preview from the seed colors */}
          <svg width="0" height="0" style={{position:'absolute',pointerEvents:'none'}} aria-hidden="true">
            <defs>
              <SeedCutoutFilter id={filterId} seeds={effectiveSeedColors} tolerance={seeds.tolerance} edgeQuality={50} mode="cutout"/>
              <SeedCutoutFilter id={filterId+'-matte'} seeds={effectiveSeedColors} tolerance={seeds.tolerance} edgeQuality={50} mode="matte"/>
            </defs>
          </svg>
          {/* Background layer — always the checkerboard for transparency */}
          {showCutout && (
            <div className="checker" style={{position:'absolute',inset:0}}/>
          )}

          {/* Original photo */}
          {!showCutout && (
            <img src={image.original} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'fill',display:'block'}} draggable={false}/>
          )}

          {/* Cutout subject — v12: rendered from a canvas-computed PNG so
              every sampled seed color contributes to the erase (the prior
              SVG-filter chain silently capped out at ~2 seeds). */}
          {showCutout && liveCutoutUrl && (
            <img src={liveCutoutUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'fill',display:'block'}} draggable={false}/>
          )}

          {/* PROTECTED PIXELS — v13: folded into the live cutout itself, so
             protected regions render with the actual original pixels in the
             same coordinate system as the cutout. No overlay layer needed
             (v12's SVG <image> with preserveAspectRatio didn't match the
             stretched cutout <img> and caused a visible offset/scale jump
             at the protect boundary). The brush-cursor outline still
             provides real-time feedback during painting. */}

          {/* Status banner — shifts text based on whether the image has been detected yet */}
          {!showCutout && (
            <div style={{
              position:'absolute',top:10,left:10,padding:'4px 8px',
              background: image.processed ? 'rgba(255,255,255,.92)' : 'color-mix(in oklch, var(--accent) 30%, #fff)',
              border:`1px solid ${image.processed ? 'var(--line)' : 'var(--line-2)'}`,boxShadow:'0 1px 3px rgba(120,90,40,.12)',backdropFilter:'blur(8px)',
              borderRadius:5,fontSize:10.5,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--fg-0)',fontWeight:600,
              display:'inline-flex',alignItems:'center',gap:6,
            }}>
              {!image.processed && <span style={{width:6,height:6,borderRadius:'50%',background:'var(--primary)'}}/>}
              {image.processed ? 'Original' : 'Not detected yet'}
            </div>
          )}

          {/* Guided seed overlay — drawn in the stage-frame's coordinate space */}
          {guiding && (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:3,overflow:'visible'}}>
              {/* Box(es) (committed) + draft drag preview */}
              {(() => {
                const committed = (seeds.boxes && seeds.boxes.length) ? seeds.boxes : (seeds.box ? [seeds.box] : []);
                const draft = seeds.drawing?.kind==='box' ? seeds.drawing : null;
                const allBoxes = draft ? [...committed, draft] : committed;
                if(!allBoxes.length) return null;
                return (
                  <g>
                    <defs>
                      <mask id="box-cut">
                        <rect x="0" y="0" width="100" height="100" fill="white"/>
                        {allBoxes.map((b, i) => (
                          <rect key={i} x={b.x*100} y={b.y*100} width={b.w*100} height={b.h*100} fill="black"/>
                        ))}
                      </mask>
                    </defs>
                    <rect x="0" y="0" width="100" height="100" fill="rgba(40,28,14,.30)" mask="url(#box-cut)"/>
                    {allBoxes.map((b, i) => (
                      <g key={i}>
                        <rect x={b.x*100} y={b.y*100} width={b.w*100} height={b.h*100}
                          fill="none" stroke="oklch(0.45 0.07 55)" strokeWidth="0.4" strokeDasharray="1.2 0.8" vectorEffect="non-scaling-stroke" style={{strokeWidth:1.5}}/>
                        {[[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]].map(([x,y],j)=>(
                          <circle key={j} cx={x*100} cy={y*100} r="0.6" fill="white" stroke="oklch(0.45 0.07 55)" strokeWidth="0.25" vectorEffect="non-scaling-stroke" style={{strokeWidth:1.2}}/>
                        ))}
                      </g>
                    ))}
                  </g>
                );
              })()}

              {/* Refine pins removed in v9 — Box mode is purely additive boxes now. */}
            </svg>
          )}
        </div>
      </div>


      {/* Custom brush cursor */}
      {brushing && cursorPos && (
        <div style={{
          position:'absolute', pointerEvents:'none', zIndex:5,
          left: cursorPos.x, top: cursorPos.y,
          width: brush.size, height: brush.size, transform:'translate(-50%,-50%)',
          borderRadius:'50%',
          border:`1.5px solid ${brushColor}`,
          background:`color-mix(in oklch, ${brushColor} 14%, transparent)`,
          boxShadow:`0 0 0 1px rgba(255,255,255,.9), 0 1px 4px rgba(0,0,0,.18)`,
        }}/>
      )}

      {/* Protect-brush cursor */}
      {/* The protect stroke is stored in image-natural px (size) and rasterized
          into the working-image canvas, then displayed scaled to `base` (the
          fit-to-pane stage-frame width) and further by `zoom`. So the on-screen
          diameter of an actual stroke = size * (base / W) * zoom. The cursor
          must use the same ratio or it visually lies about brush coverage. */}
      {protecting && cursorPos && (() => {
        const W = imgDims?.w || 1;
        const screenPerImage = (base / W) * zoom;
        const sz = (seeds.protectBrushSize ?? 100) * screenPerImage;
        return (
          <div style={{
            position:'absolute', pointerEvents:'none', zIndex:7,
            left: cursorPos.x, top: cursorPos.y,
            width: sz, height: sz, transform:'translate(-50%,-50%)',
            borderRadius:'50%',
            border:`1.5px solid oklch(0.62 0.13 145)`,
            background:`color-mix(in oklch, oklch(0.62 0.13 145) 18%, transparent)`,
            boxShadow:`0 0 0 1px rgba(255,255,255,.9), 0 1px 4px rgba(0,0,0,.18)`,
          }}/>
        );
      })()}

      {/* Sample paintbrush cursor — sized from the brush diameter (image px)
          mapped to on-screen px, same math as the protect cursor. Reddish to
          signal "removal". */}
      {samplePainting && cursorPos && (() => {
        const W = imgDims?.w || 1;
        const screenPerImage = (base / W) * zoom;
        const sz = (seeds.eraseBrushSize ?? 60) * screenPerImage;
        return (
          <div style={{
            position:'absolute', pointerEvents:'none', zIndex:7,
            left: cursorPos.x, top: cursorPos.y,
            width: sz, height: sz, transform:'translate(-50%,-50%)',
            borderRadius:'50%',
            border:`1.5px solid oklch(0.55 0.18 28)`,
            background:`color-mix(in oklch, oklch(0.55 0.18 28) 14%, transparent)`,
            boxShadow:`0 0 0 1px rgba(255,255,255,.9), 0 1px 4px rgba(0,0,0,.18)`,
          }}/>
        );
      })()}

      {/* Brush mode banner */}
      {brushing && (
        <div style={{
          position:'absolute',top:10,right:10,padding:'4px 9px',background:'rgba(255,255,255,.94)',
          border:`1px solid ${brushColor}`,borderRadius:5,fontSize:10.5,fontWeight:600,letterSpacing:'.06em',textTransform:'uppercase',
          color:'var(--fg-0)',display:'flex',alignItems:'center',gap:6,zIndex:5,
        }}>
          <span style={{width:6,height:6,borderRadius:'50%',background:brushColor}}/>
          {brush.mode === 'keep' ? 'Keep brush' : 'Remove brush'} · {brush.size}px
        </div>
      )}

      {/* Bottom-left zoom + Fit pill */}
      <div className="zoom-pill">
        <button onClick={()=>setZoom(z=>Math.max(.1, z*0.85))} title="Zoom out"><Icon.Minus/></button>
        <span className="mono val">{Math.round(zoom*100)}%</span>
        <button onClick={()=>setZoom(z=>Math.min(8, z*1.18))} title="Zoom in"><Icon.Plus/></button>
        <span className="zoom-pill-sep"/>
        <button onClick={onFit} title="Fit to pane" className="fit-btn">Fit</button>
      </div>

      {/* Bottom-right info pill (file/size) */}
      <div className="info-pill">
        <span className="mono"><span className="k">file</span><span className="v">{image.name}.{image.ext || 'jpg'}</span></span>
        <span className="mono"><span className="k">size</span><span className="v">{image.width}×{image.height}</span></span>
      </div>

      {showOrigClick && (
        <div style={{
          position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
          padding:'8px 14px',background:'rgba(255,255,255,.95)',border:'1px solid var(--line)',borderRadius:8,
          boxShadow:'0 8px 24px rgba(120,90,40,.18)',backdropFilter:'blur(10px)',
          fontSize:11,color:'var(--fg-0)',pointerEvents:'none',zIndex:4,
          animation:'pulse .6s ease',
        }}>
          {s.showOriginal ? 'Cutout' : 'Original'}
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Contact sheet — v4 shows originals; cutout previews only render for the active image.
function ContactSheet({images, activeId, selectedIds, onSelect, onActivate, columns=6}){
  return (
    <div className="contact nice-scroll">
      <div className="contact-grid" style={{gridTemplateColumns:`repeat(${columns},1fr)`}}>
        {images.map(img=>{
          const sel = selectedIds.has(img.id);
          const act = activeId === img.id;
          return (
            <div key={img.id} className={`contact-item ${sel?'selected':''} ${act?'active':''}`}
                 onClick={(e)=>onSelect(img.id,e)}
                 onDoubleClick={()=>onActivate(img.id)}>
              <div style={{aspectRatio:'1/1',position:'relative'}}>
                {img.processed && img.cutoutDataUrl ? (
                  <div className="checker" style={{position:'absolute',inset:0}}>
                    <img src={img.cutoutDataUrl} alt=""
                         style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain'}} draggable={false}/>
                  </div>
                ) : (
                  <img src={img.original} alt=""
                       style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} draggable={false}/>
                )}
              </div>
              <div className="label">
                <span className="name mono">{img.name}.{img.ext || 'jpg'}</span>
                <span className="px mono">{img.width}×{img.height}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Export Modal
function ExportModal({images, selectedIds, settings, onClose, onConfirm}){
  const [scope, setScope] = useState(selectedIds.size > 1 ? 'selected' : 'all');
  const [pattern, setPattern] = useState(settings.pattern);
  const [format, setFormat] = useState(settings.format);
  const [destination, setDestination] = useState('~/Pictures/Cutouts/');
  const destPickerRef = useRef(null);

  const ext = format.toLowerCase() === 'jpg' ? 'jpg' : format.toLowerCase();
  const targets = scope==='selected' ? images.filter(i=>selectedIds.has(i.id))
                : scope==='processed' ? images.filter(i=>i.processed)
                : images;
  const previews = targets.slice(0,3).map((img, i) => composeName(pattern, img, i, ext));

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <h2>
          <span>Export cutouts</span>
          <button className="modal-x" onClick={onClose}><Icon.Close/></button>
        </h2>
        <div className="modal-body">
          <div className="modal-row">
            <label>Apply to</label>
            <div className="scope-row">
              <div className={`scope-tile ${scope==='selected'?'on':''}`} onClick={()=>setScope('selected')}>
                <span className="t">Selection</span>
                <span className="n mono">{selectedIds.size} images</span>
              </div>
              <div className={`scope-tile ${scope==='processed'?'on':''}`} onClick={()=>setScope('processed')}>
                <span className="t">Processed only</span>
                <span className="n mono">{images.filter(i=>i.processed).length} images</span>
              </div>
              <div className={`scope-tile ${scope==='all'?'on':''}`} onClick={()=>setScope('all')}>
                <span className="t">All</span>
                <span className="n mono">{images.length} images</span>
              </div>
            </div>
          </div>

          <div className="modal-row">
            <label>Destination folder</label>
            <div style={{display:'flex',gap:6,alignItems:'stretch'}}>
              <input
                className="input mono"
                value={destination}
                onChange={e=>setDestination(e.target.value)}
                style={{flex:1,minWidth:0}}
              />
              <input
                ref={destPickerRef}
                type="file"
                /* @ts-ignore — non-standard but widely supported folder picker */
                webkitdirectory=""
                directory=""
                multiple
                style={{display:'none'}}
                onChange={e=>{
                  const f = e.target.files && e.target.files[0];
                  if(!f) return;
                  // webkitRelativePath looks like "Cutouts/sub/img.jpg" — take the
                  // top-level folder name the user actually picked.
                  const rel = f.webkitRelativePath || f.name;
                  const top = rel.split('/')[0];
                  setDestination(top ? `~/${top}/` : '~/');
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="tb-btn ghost"
                onClick={()=>destPickerRef.current && destPickerRef.current.click()}
                style={{flexShrink:0,whiteSpace:'nowrap'}}
              >
                <Icon.Folder/> Choose…
              </button>
            </div>
          </div>

          <div style={{display:'grid',gridTemplateColumns:'1fr 120px',gap:10}}>
            <div className="modal-row">
              <label>Filename pattern</label>
              <input className="input mono" value={pattern} onChange={e=>setPattern(e.target.value)}/>
            </div>
            <div className="modal-row">
              <label>Format</label>
              <div className="seg" style={{height:30,padding:2}}>
                {['PNG','WebP','JPG'].map(f=>(
                  <button key={f} className={format===f?'on':''} onClick={()=>setFormat(f)} style={{flex:1,height:24,fontSize:11}}>{f}</button>
                ))}
              </div>
            </div>
          </div>

        </div>
        <div className="modal-foot">
          <span className="mono" style={{fontSize:11,color:'var(--fg-2)'}}>
            {targets.length} files • ~{(targets.length * 1.4).toFixed(1)} MB
          </span>
          <div style={{display:'flex',gap:8}}>
            <button className="tb-btn ghost" onClick={onClose}>Cancel</button>
            <button className="tb-btn primary" onClick={()=>onConfirm({scope, pattern, format, destination, targetCount: targets.length})}>
              <Icon.Download/> Export {targets.length} files
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main App
function App(){
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [images, setImages] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(()=>new Set());
  const [view, setView] = useState('single');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({x:0, y:0});
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState({name:'', loaded:false});
  const [showExport, setShowExport] = useState(false);
  const [progress, setProgress] = useState(0);
  const [peekOriginal, setPeekOriginal] = useState(false);
  const [toast, setToast] = useState(null);
  const [showOrigClick, setShowOrigClick] = useState(false);

  const [s, setS] = useState({
    // Legacy luminance-keying values — still used to drive the SVG filter,
    // but in v2 the user only directly controls `edgeQuality` (which maps onto
    // smoothing + feather + contraction below) and the model decides threshold.
    threshold: 50,
    feather: 14,
    smooth: 35,
    edge: 0,
    edgeQuality: 50,        // single-dial replacement
    matte: false,
    showOriginal: false,
    format: 'PNG',
    pattern: '{name}_cutout_{NN}.{ext}',
  });

  // Refine brush state
  const [brush, setBrush] = useState({mode:'off', size:32});
  const [maskEdits, setMaskEdits] = useState({}); // {imageId: trueIfEdited}
  const hasMaskEdits = !!(activeId && maskEdits[activeId]);

  // Guided detection state — per-image so seeds persist when toggling images.
  // Default: empty seeds, no mode active.
  const emptySeeds = {boxes:[], box:null, pins:[], protectStrokes:[], bgSamples:[], eraseStrokes:[], tolerance:32, drawing:null, sampleTool:'click', eraseBrushSize:60};
  // v5 — default to Box. In testing it produced the most reliable cuts because
  // it samples corner pixels (almost always background) regardless of subject.
  const [guidedMode, setGuidedMode] = useState('sample'); // 'sample'|'protect'
  const [seedsByImg, setSeedsByImg] = useState({}); // {imageId: seedsObj}
  const [guidedConfByImg, setGuidedConfByImg] = useState({}); // {imageId: 0..1}
  const seeds = (activeId && seedsByImg[activeId]) || emptySeeds;
  const guidedConfidence = activeId ? (guidedConfByImg[activeId] ?? null) : null;
  const setSeeds = useCallback((updater) => {
    if(!activeId) return;
    setSeedsByImg(prev => {
      const cur = prev[activeId] || emptySeeds;
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return {...prev, [activeId]: next};
    });
  }, [activeId]);

  // ── Undo / Redo / Undo-All history (per image) ────────────────────────────
  // Every committed edit (sample, paintbrush stroke, restore stroke, box,
  // chip removal, clear) pushes a snapshot of the *prior* committed seed state
  // onto a per-image past stack. Undo pops it back; Redo re-applies; Undo All
  // wipes everything so the image returns to its untouched original.
  const [historyByImg, setHistoryByImg] = useState({}); // {id:{past:[], future:[]}}
  const history = (activeId && historyByImg[activeId]) || {past:[], future:[]};
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  // Live ref of committed seeds so commit helpers read the freshest state
  // without waiting on a re-render.
  const seedsByImgRef = useRef(seedsByImg);
  seedsByImgRef.current = seedsByImg;

  // pushHistory — record a pre-action committed snapshot. Called by the canvas
  // at the end of a drag gesture and by commitSeeds for immediate edits.
  const pushHistory = useCallback((snapshot) => {
    if(!activeId || !snapshot) return;
    setHistoryByImg(prev => {
      const h = prev[activeId] || {past:[], future:[]};
      return {...prev, [activeId]: {past:[...h.past, snapshot], future:[]}};
    });
  }, [activeId]);

  // commitSeeds — for immediate (non-drag) edits: snapshot the current state,
  // then apply the change. Drag gestures manage their own snapshot timing.
  const commitSeeds = useCallback((updater) => {
    if(!activeId) return;
    const cur = seedsByImgRef.current[activeId] || emptySeeds;
    pushHistory({...cur, drawing:null});
    setSeeds(updater);
  }, [activeId, pushHistory, setSeeds]);

  // Undo/Redo restore only the *content* of a seed snapshot (what was placed),
  // keeping the user's current tool/brush prefs. Otherwise stepping back through
  // a sample would also revert an unrelated Click↔Paintbrush toggle or brush-size
  // change the user made afterward (those go through plain setSeeds, not history).
  const restoreSeedContent = (cur, snap) => ({
    ...cur,                 // keep prefs: sampleTool, eraseBrushSize, protectBrushSize, tolerance
    boxes: snap.boxes, box: snap.box, pins: snap.pins,
    bgSamples: snap.bgSamples, protectStrokes: snap.protectStrokes, eraseStrokes: snap.eraseStrokes,
    drawing: null,
  });

  const onUndo = useCallback(() => {
    if(!activeId) return;
    const h = historyByImg[activeId] || {past:[], future:[]};
    if(!h.past.length) return;
    const cur = {...(seedsByImgRef.current[activeId] || emptySeeds), drawing:null};
    const restored = restoreSeedContent(cur, h.past[h.past.length - 1]);
    setSeedsByImg(p => ({...p, [activeId]: restored}));
    setHistoryByImg(p => ({...p, [activeId]: {past:h.past.slice(0, -1), future:[cur, ...h.future]}}));
  }, [activeId, historyByImg]);

  const onRedo = useCallback(() => {
    if(!activeId) return;
    const h = historyByImg[activeId] || {past:[], future:[]};
    if(!h.future.length) return;
    const cur = {...(seedsByImgRef.current[activeId] || emptySeeds), drawing:null};
    const restored = restoreSeedContent(cur, h.future[0]);
    setSeedsByImg(p => ({...p, [activeId]: restored}));
    setHistoryByImg(p => ({...p, [activeId]: {past:[...h.past, cur], future:h.future.slice(1)}}));
  }, [activeId, historyByImg]);

  // Undo All — restore the active image to its original, untouched state.
  const onUndoAll = useCallback(() => {
    if(!activeId) return;
    setSeedsByImg(prev => { const n = {...prev}; delete n[activeId]; return n; });
    setHistoryByImg(prev => { const n = {...prev}; delete n[activeId]; return n; });
    setGuidedConfByImg(prev => { const n = {...prev}; delete n[activeId]; return n; });
    setMaskEdits(m => { const n = {...m}; delete n[activeId]; return n; });
    setImages(imgs => imgs.map(i => i.id === activeId ? {...i, processed:false, cutoutDataUrl:null, cutoutBlob:null} : i));
    showToast('Reverted to original');
  }, [activeId]);

  // Clear — drop all placed seeds for the active image (undoable).
  const onClearSeeds = () => {
    if(!activeId) return;
    commitSeeds(s => ({...s, boxes:[], box:null, protectStrokes:[], bgSamples:[], eraseStrokes:[], drawing:null}));
    showToast('Seeds cleared');
  };

  // Auto-Keep — "Keep" is no longer a manual button; the cutout is committed to
  // the filmstrip automatically (debounced) after every edit. When all seeds
  // are gone (Undo All, or undoing back to empty) the thumbnail snaps back to
  // the original. This keeps the right-rail in sync without the user having to
  // remember to press anything.
  useEffect(() => {
    if(!activeId) return;
    // A real cutout needs a removal input — a color sample, a box, or an erase
    // stroke. Protect strokes alone modify nothing (rasterizeCutout keeps the
    // image as-is), so they don't count toward "has a cutout".
    const hasAny = ((seeds.boxes?.length || 0)
      + (seeds.bgSamples?.length || 0)
      + (seeds.eraseStrokes?.length || 0)) > 0;
    if(!hasAny){
      setImages(imgs => imgs.some(i => i.id === activeId && i.processed)
        ? imgs.map(i => (i.id === activeId)
            ? {...i, processed:false, cutoutDataUrl:null, cutoutBlob:null}
            : i)
        : imgs);
      return;
    }
    const img = images.find(i => i.id === activeId);
    if(!img) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const {dataUrl, blob, width, height} = await rasterizeCutout(img, seeds, 'png');
        if(cancelled) return;
        setImages(imgs => imgs.map(i => i.id === activeId
          ? {...i, processed:true, cutoutDataUrl: dataUrl, cutoutBlob: blob, cutoutW: width, cutoutH: height}
          : i));
      } catch(err){
        if(!cancelled) setImages(imgs => imgs.map(i => i.id === activeId ? {...i, processed:true} : i));
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  // Intentionally keyed on the committed seed fields only (not `drawing` or
  // `images`) so in-progress strokes don't trigger renders mid-drag.
  }, [activeId, seeds.bgSamples, seeds.boxes, seeds.eraseStrokes, seeds.protectStrokes, seeds.tolerance]);
  const onResetMask = () => {
    if(!activeId) return;
    setMaskEdits(m => { const n = {...m}; delete n[activeId]; return n; });
    showToast('Refinements cleared');
  };

  // Engine state — in real life this would lazy-load a WebGPU model
  const [engineStatus, setEngineStatus] = useState('ready'); // 'idle' | 'running' | 'ready'
  const setEngine = (key) => {
    setTweak('engine', key);
    setEngineStatus('running');
    setTimeout(()=>setEngineStatus('ready'), 900);
    showToast(`Switched to ${ENGINES[key].name}`);
  };
  const onRedetect = () => {
    if(!activeId) return;
    setEngineStatus('running');
    setTimeout(()=>{
      setEngineStatus('ready');
      setImages(imgs => imgs.map(i => i.id === activeId ? {...i, processed:true} : i));
      showToast('Subject re-detected');
    }, 700);
  };

  // Guided detection — uses the seeds the user placed to drive a (simulated)
  // segmentation. We compute a confidence score from how much guidance was
  // provided so the UI feels responsive even without a real model.
  const onGuidedDetect = () => {
    if(!activeId) return;
    const boxesCount = (seeds.boxes?.length || (seeds.box ? 1 : 0));
    const totalSeeds = boxesCount + (seeds.protectStrokes?.length || 0);
    if(totalSeeds === 0){ showToast('Add at least one seed first'); return; }
    setEngineStatus('running');
    // confidence model: more seeds + boxes → higher confidence, asymptotic to .98
    const score = 0.55
      + Math.min(0.30, boxesCount * 0.12)
      + Math.min(0.15, (seeds.protectStrokes?.length || 0) * 0.05);
    const conf = Math.min(0.98, score);
    setTimeout(()=>{
      setEngineStatus('ready');
      setImages(imgs => imgs.map(i => i.id === activeId ? {...i, processed:true} : i));
      setGuidedConfByImg(prev => ({...prev, [activeId]: conf}));
      showToast(`Detected with seeds · ${Math.round(conf*100)}% confidence`);
    }, 750);
  };

  // AI analyze — sends the active image to Claude and applies the returned
  // boxes + protect strokes as new seeds. Replaces existing seeds for that image.
  const [analyzing, setAnalyzing] = useState(false);
  const onAIAnalyze = async () => {
    if(!activeId) { showToast('Select an image first'); return; }
    const img = images.find(i => i.id === activeId);
    if(!img) return;
    if(typeof window.claude?.complete !== 'function'){
      showToast('AI not available in this environment');
      return;
    }
    setAnalyzing(true);
    setEngineStatus('running');
    showToast('Claude is analyzing the image…');
    try {
      const plan = await analyzeImageWithClaude(img);
      setSeedsByImg(prev => ({
        ...prev,
        [activeId]: {
          boxes: plan.boxes,
          box: null,
          pins: [],
          protectStrokes: plan.protectStrokes,
          tolerance: plan.tolerance,
          protectBrushSize: 100,
          drawing: null,
        },
      }));
      setGuidedConfByImg(prev => ({...prev, [activeId]: plan.confidence}));
      setEngineStatus('ready');
      const summary = plan.description || `${plan.boxes.length} boxes · ${plan.protectStrokes.length} protect strokes`;
      showToast('AI: ' + summary.slice(0, 120));
    } catch(err){
      console.error('AI analyze failed:', err);
      setEngineStatus('ready');
      showToast('AI analysis failed: ' + (err.message || 'unknown'));
    } finally {
      setAnalyzing(false);
    }
  };

  // 0 (Crisp) → minimal blur, slight erode
  // 50 (Natural) → moderate feather, no contraction
  // 100 (Very soft) → wide feather, slight dilate
  useEffect(()=>{
    const q = s.edgeQuality / 100;
    const feather = Math.round(q * 28);
    const smooth  = Math.round(20 + q * 50);
    const edge    = Math.round((q - 0.5) * 6); // -3 .. +3
    setS(prev => (prev.feather===feather && prev.smooth===smooth && prev.edge===edge)
      ? prev
      : {...prev, feather, smooth, edge});
  }, [s.edgeQuality]);

  const activeImage = images.find(i => i.id === activeId);
  const processedCount = images.filter(i=>i.processed).length;

  // Reset zoom/pan to "Fit" whenever the active image changes — every image
  // opens centered in the canvas-wrap at 1× (which is itself fit-to-pane,
  // since SingleCanvas sizes the stage-frame from natural aspect).
  useEffect(() => {
    setZoom(1);
    setPan({x: 0, y: 0});
  }, [activeId]);

  const onFit = useCallback(() => {
    setZoom(1);
    setPan({x: 0, y: 0});
  }, []);

  // selection helpers
  const onSelect = useCallback((id, e) => {
    setActiveId(id);
    if(e?.shiftKey){
      const ids = images.map(i=>i.id);
      const lastId = activeId;
      const a = ids.indexOf(lastId), b = ids.indexOf(id);
      const [lo, hi] = a < b ? [a,b] : [b,a];
      const range = new Set(ids.slice(lo, hi+1));
      setSelectedIds(prev => new Set([...prev, ...range]));
    } else if(e?.metaKey || e?.ctrlKey){
      setSelectedIds(prev => {
        const next = new Set(prev);
        if(next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    } else {
      setSelectedIds(new Set([id]));
    }
  }, [images, activeId]);

  const onActivate = useCallback((id) => {
    setActiveId(id); setView('single');
    setSelectedIds(new Set([id]));
  }, []);

  // keyboard shortcuts
  useEffect(()=>{
    const onKey = (e) => {
      if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // Undo / Redo — ⌘Z / ⇧⌘Z (and Ctrl+Y for redo on Windows-style kbds).
      if((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')){
        e.preventDefault();
        if(e.shiftKey) onRedo(); else onUndo();
        return;
      }
      if((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')){
        e.preventDefault(); onRedo(); return;
      }
      if(e.key === 'g') setView(v => v==='single'?'contact':'single');
      if(e.key === ' '){ e.preventDefault(); setPeekOriginal(true); }
      if(e.key === 'Escape') setSelectedIds(new Set([activeId]));
      // protect-brush size shortcuts
      if((e.key === '[' || e.key === ']') && guidedMode === 'protect' && activeId){
        const delta = e.key === '[' ? -4 : 4;
        setSeedsByImg(prev => {
          const cur = prev[activeId] || emptySeeds;
          const next = Math.max(8, Math.min(500, (cur.protectBrushSize ?? 100) + delta * 4));
          return {...prev, [activeId]: {...cur, protectBrushSize: next}};
        });
      }
      // sample-paintbrush size shortcuts
      if((e.key === '[' || e.key === ']') && guidedMode === 'sample' && activeId){
        const delta = e.key === '[' ? -1 : 1;
        setSeedsByImg(prev => {
          const cur = prev[activeId] || emptySeeds;
          if((cur.sampleTool ?? 'click') !== 'paint') return prev;
          const next = Math.max(8, Math.min(400, (cur.eraseBrushSize ?? 60) + delta * 12));
          return {...prev, [activeId]: {...cur, eraseBrushSize: next}};
        });
      }
      // arrow nav
      if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        const ids = images.map(i=>i.id);
        const idx = ids.indexOf(activeId);
        const next = e.key === 'ArrowDown' ? (idx+1) % ids.length : (idx-1+ids.length) % ids.length;
        setActiveId(ids[next]); setSelectedIds(new Set([ids[next]]));
      }
    };
    const onUp = (e) => { if(e.key === ' ') setPeekOriginal(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return ()=>{ window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, [activeId, images, guidedMode, onUndo, onRedo]);

  // toast helper
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(()=>setToast(null), 2400);
  };

  const onApplyToSelected = () => {
    if(selectedIds.size <= 1){ showToast('Select multiple images to batch-apply.'); return; }
    setImages(imgs => imgs.map(i => selectedIds.has(i.id) ? {...i, processed:true} : i));
    showToast(`Applied to ${selectedIds.size} images`);
  };
  const onApplyToAll = () => {
    setImages(imgs => imgs.map(i => ({...i, processed:true})));
    showToast(`Applied to ${images.length} images`);
  };

  const onConfirmExport = async (opts) => {
    setShowExport(false);
    const targets = opts.scope==='selected' ? images.filter(i=>selectedIds.has(i.id))
                  : opts.scope==='processed' ? images.filter(i=>i.processed)
                  : images;
    if(targets.length === 0){ showToast('Nothing to export'); return; }

    const fmt = (opts.format || 'PNG').toLowerCase();
    const ext = fmt === 'jpg' || fmt === 'jpeg' ? 'jpg' : fmt;
    setProgress(0.02);

    let exported = 0;
    for(let idx=0; idx<targets.length; idx++){
      const img = targets[idx];
      const filename = composeName(opts.pattern, img, idx, ext);
      try {
        let blob;
        // Prefer the kept cutout if formats match; otherwise re-rasterize.
        if(img.cutoutBlob && (fmt === 'png')){
          blob = img.cutoutBlob;
        } else {
          // Try to use this image's seeds if any; otherwise rasterize from current active seeds when it's the active image
          const imgSeeds = seedsByImg[img.id] || (img.id === activeId ? seeds : null);
          if(imgSeeds && ((imgSeeds.boxes && imgSeeds.boxes.length) || imgSeeds.box || (imgSeeds.protectStrokes && imgSeeds.protectStrokes.length))){
            const out = await rasterizeCutout(img, imgSeeds, fmt);
            blob = out.blob;
          } else if(img.cutoutBlob){
            // Re-encode the kept PNG into the requested format
            const out = await rasterizeCutout(img, {box:null, protectStrokes:[]}, fmt);
            blob = out.blob;
          } else {
            // No cutout info — export the original re-encoded
            const out = await rasterizeCutout(img, {box:null, protectStrokes:[]}, fmt);
            blob = out.blob;
          }
        }
        if(blob){
          downloadBlob(blob, filename);
          exported++;
        }
      } catch(err){
        console.error('Export failed for', img.name, err);
      }
      setProgress(0.05 + (idx+1)/targets.length * 0.92);
      // small yield so the browser can keep up with rapid downloads
      await new Promise(r => setTimeout(r, 60));
    }
    setProgress(1);
    setTimeout(()=>setProgress(0), 500);
    showToast(`Exported ${exported} ${opts.format} file${exported===1?'':'s'}`);

    // mark exported targets as processed
    setImages(imgs => imgs.map(i => {
      const inScope = opts.scope==='all' || (opts.scope==='selected' && selectedIds.has(i.id)) || (opts.scope==='processed' && i.processed);
      return inScope ? {...i, processed:true} : i;
    }));
  };

  const onLoad = () => {
    // Toolbar's "Open folder…" triggers the rail folder picker via the same handler.
    document.getElementById('app-folder-input')?.click();
  };

  // Convert real files into image entries
  const filesToImages = useCallback((files, baseIdx) => {
    return files.map((f, i) => {
      const url = URL.createObjectURL(f);
      const dot = f.name.lastIndexOf('.');
      const name = dot > 0 ? f.name.slice(0, dot) : f.name;
      const ext = (dot > 0 ? f.name.slice(dot+1) : 'jpg').toLowerCase();
      return {
        id: `real-${Date.now()}-${baseIdx+i}`,
        idx: baseIdx + i,
        name, ext,
        width: 0, height: 0,
        kind: 'photo',
        original: url,
        // For real images we don't have a programmatic cutout — show original with a checker peek.
        // The "processed" state still drives whether the contact sheet shows as transparent-bg cutout.
        cutout: () => url,
        processed: false,
        real: true,
        file: f,
        relPath: f.webkitRelativePath || f.name,
      };
    });
  }, []);

  // Read real intrinsic dimensions
  const measureImage = (url) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({w: im.naturalWidth, h: im.naturalHeight});
    im.onerror = () => resolve({w: 0, h: 0});
    im.src = url;
  });

  const onLoadFiles = useCallback(async (files) => {
    const baseIdx = images.length;
    const newImgs = filesToImages(files, baseIdx);
    setImages(prev => [...newImgs, ...prev]);
    if(newImgs[0]){ setActiveId(newImgs[0].id); setSelectedIds(new Set([newImgs[0].id])); }
    showToast(`Added ${newImgs.length} image${newImgs.length===1?'':'s'}`);
    // backfill dimensions
    for(const img of newImgs){
      const {w, h} = await measureImage(img.original);
      setImages(prev => prev.map(p => p.id === img.id ? {...p, width:w, height:h} : p));
    }
  }, [images.length, filesToImages]);

  const onLoadFolder = useCallback(async (files) => {
    const baseIdx = images.length;
    const newImgs = filesToImages(files, baseIdx);
    // pull folder name from first file's webkitRelativePath
    const rel = files[0]?.webkitRelativePath || '';
    const folderName = rel.includes('/') ? rel.split('/')[0] : 'Loaded folder';
    setImages(prev => [...newImgs, ...prev]);
    setFolder({name: folderName, loaded: true});
    if(newImgs[0]){ setActiveId(newImgs[0].id); setSelectedIds(new Set([newImgs[0].id])); }
    showToast(`Loaded ${newImgs.length} images from ${folderName}`);
    for(const img of newImgs){
      const {w, h} = await measureImage(img.original);
      setImages(prev => prev.map(p => p.id === img.id ? {...p, width:w, height:h} : p));
    }
  }, [images.length, filesToImages]);

  const onClearReal = useCallback(() => {
    setImages(prev => {
      prev.forEach(p => { if(p.real && p.original) URL.revokeObjectURL(p.original); });
      return [];
    });
    setActiveId(null);
    setSelectedIds(new Set());
    setFolder({name:'', loaded:false});
    showToast('Cleared all images');
  }, []);

  const onClickToggle = () => {
    setShowOrigClick(true);
    setTimeout(()=>setShowOrigClick(false), 700);
    setS(s => ({...s, showOriginal: !s.showOriginal}));
  };

  return (
    <div className="app">
      <Toolbar
        view={view} setView={setView}
        onLoad={onLoad}
        onExport={()=>setShowExport(true)}
        onAnalyze={onAIAnalyze}
        analyzing={analyzing}
        processedCount={processedCount}
        totalCount={images.length}
        dirName={folder.name}
        hasFolder={folder.loaded}
      />
      {progress > 0 && <div className="progress" style={{transform:`scaleX(${progress})`}}/>}

      <div className="main" style={view==='contact' && images.length > 0 ? {gridTemplateColumns:'1fr'} : null}>
        {!(view==='contact' && images.length > 0) && (
          <ControlsPanel
                         activeImage={activeImage}
                         guidedMode={guidedMode} setGuidedMode={setGuidedMode}
                         seeds={seeds} setSeeds={setSeeds} commitSeeds={commitSeeds}
                         onClearSeeds={onClearSeeds}
                         canUndo={canUndo} canRedo={canRedo}
                         onUndo={onUndo} onRedo={onRedo} onUndoAll={onUndoAll}/>
        )}

        {images.length === 0 ? (
          <div className="canvas-wrap">
            <div className="empty">
              <div className="ic"><Icon.Image size={28}/></div>
              <h3>No images loaded</h3>
              <p>Use <b>Folder</b> or <b>Files</b> in the right panel — or drag image files anywhere on this window — to get started.</p>
              <div style={{display:'flex',gap:8,marginTop:6}}>
                <button className="tb-btn ghost" onClick={()=>document.getElementById('app-folder-input')?.click()}>
                  <Icon.Folder size={12}/> Choose folder
                </button>
                <button className="tb-btn primary" onClick={()=>document.getElementById('app-file-input')?.click()}>
                  <Icon.Image size={12}/> Choose files
                </button>
              </div>
            </div>
            <input id="app-folder-input" type="file" webkitdirectory="" directory="" multiple style={{display:'none'}}
                   onChange={e=>{ const fl = Array.from(e.target.files||[]).filter(f=>f.type.startsWith('image/')); if(fl.length) onLoadFolder(fl); e.target.value=''; }}/>
            <input id="app-file-input" type="file" accept="image/*" multiple style={{display:'none'}}
                   onChange={e=>{ const fl = Array.from(e.target.files||[]).filter(f=>f.type.startsWith('image/')); if(fl.length) onLoadFiles(fl); e.target.value=''; }}/>
          </div>
        ) : view==='single' ? (
          <SingleCanvas
            image={activeImage} s={s}
            zoom={zoom} setZoom={setZoom}
            pan={pan} setPan={setPan}
            onClickToggle={onClickToggle}
            peekOriginal={peekOriginal}
            brush={brush} setBrush={setBrush}
            guidedMode={guidedMode}
            seeds={seeds} setSeeds={setSeeds}
            pushHistory={pushHistory}
            onFit={onFit}
            showOrigClick={showOrigClick}
          />
        ) : (
          <div className="canvas-wrap">
            <div style={{position:'absolute',top:14,left:16,fontSize:11,color:'var(--fg-2)',letterSpacing:'.06em',textTransform:'uppercase'}}>
              Contact sheet · {images.length} images · double-click to open
            </div>
            <ContactSheet images={images} activeId={activeId} selectedIds={selectedIds}
                          onSelect={onSelect} onActivate={onActivate} columns={6}/>
          </div>
        )}

        <Filmstrip
          images={images}
          activeId={activeId}
          selectedIds={selectedIds}
          onSelect={onSelect}
          onActivate={onActivate}
          thumbSize={t.thumbSize}
          search={search}
          setSearch={setSearch}
          onLoadFiles={onLoadFiles}
          onLoadFolder={onLoadFolder}
          onClearReal={onClearReal}
          hidden={view==='contact' && images.length > 0}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position:'fixed',bottom:38,left:'50%',transform:'translateX(-50%)',
          padding:'9px 14px',background:'rgba(255,255,255,.96)',border:'1px solid var(--line)',borderRadius:8,
          fontSize:12,color:'var(--fg-0)',zIndex:60,backdropFilter:'blur(10px)',
          boxShadow:'0 10px 30px rgba(120,90,40,.20)',
          display:'flex',alignItems:'center',gap:8,
        }}>
          <Icon.Check size={13}/> {toast}
        </div>
      )}

      {/* Export modal */}
      {showExport && (
        <ExportModal
          images={images}
          selectedIds={selectedIds}
          settings={s}
          onClose={()=>setShowExport(false)}
          onConfirm={onConfirmExport}
        />
      )}

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Display"/>
        <TweakSlider label="Thumbnail size" value={t.thumbSize} min={80} max={240} unit="px"
                     onChange={v=>setTweak('thumbSize', v)}/>
        <TweakSection label="Pipeline"/>
        <TweakToggle label="Show legacy luminance threshold"
                     value={!!t.showLegacyControls}
                     onChange={v=>setTweak('showLegacyControls', v)}/>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
