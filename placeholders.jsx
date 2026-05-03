// placeholders.jsx
// Generates SVG data URIs that simulate photo subjects on backgrounds.
// Each placeholder has: tinted bg, a "subject" silhouette region, label text.
// We'll also derive a "cutout" version where the bg is checkered and the subject is preserved.

(function(){

  const PALETTES = [
    // [bg-a, bg-b, subject-a, subject-b, accent]
    ['#3b4a5c','#1f2a36','#c9a87a','#876b46','#e2d0a8'],   // muted blue / wheat
    ['#5a4a3a','#2e251c','#8a6a4a','#52402c','#d4b48a'],   // umber
    ['#3a4a3a','#1c2820','#9aa886','#647258','#c9d6b2'],   // moss
    ['#52384a','#26161e','#b88aa0','#7a5468','#dec0d2'],   // mauve
    ['#2c3e4a','#121e26','#6c8a9e','#4a6678','#a4c0d2'],   // teal-grey
    ['#5a3838','#2a1414','#c08070','#7a4848','#e6b8a8'],   // brick
    ['#403a52','#1a1626','#8076a0','#544a72','#c0b8d8'],   // violet
    ['#4a4a3c','#22211a','#b4a47a','#766a48','#dfd0a4'],   // olive
  ];

  const SUBJECTS = [
    // Each entry: name, draw fn (returns SVG markup for the subject region),
    // composed inside a 800x800 viewBox.
    { kind:'figure',  draw: (id, p) => `
        <ellipse cx="400" cy="240" rx="92" ry="106" fill="url(#sub-${id})"/>
        <path d="M260 720 C260 540 320 430 400 430 C480 430 540 540 540 720 Z" fill="url(#sub-${id})"/>
        <path d="M340 470 C320 540 320 640 330 720 L470 720 C480 640 480 540 460 470 Z" fill="${p[3]}" opacity=".55"/>
      ` },
    { kind:'product', draw: (id, p) => `
        <rect x="270" y="260" width="260" height="380" rx="22" fill="url(#sub-${id})"/>
        <rect x="290" y="280" width="220" height="100" rx="6" fill="${p[4]}" opacity=".45"/>
        <rect x="290" y="400" width="160" height="14" rx="3" fill="${p[3]}"/>
        <rect x="290" y="424" width="120" height="10" rx="3" fill="${p[3]}" opacity=".7"/>
        <circle cx="490" cy="600" r="22" fill="${p[4]}" opacity=".7"/>
      ` },
    { kind:'bottle', draw: (id, p) => `
        <path d="M380 180 L420 180 L420 240 L440 280 L440 660 Q440 700 400 700 Q360 700 360 660 L360 280 L380 240 Z" fill="url(#sub-${id})"/>
        <rect x="365" y="380" width="70" height="120" fill="${p[4]}" opacity=".5"/>
      ` },
    { kind:'plant', draw: (id, p) => `
        <ellipse cx="400" cy="500" rx="160" ry="180" fill="url(#sub-${id})"/>
        <path d="M400 320 Q300 380 270 500 Q380 460 400 380 Q420 460 530 500 Q500 380 400 320Z" fill="${p[4]}" opacity=".55"/>
        <rect x="350" y="600" width="100" height="100" rx="8" fill="${p[3]}"/>
      ` },
    { kind:'shoe', draw: (id, p) => `
        <path d="M180 520 Q260 460 380 460 L520 460 Q620 460 620 540 L620 600 Q620 640 560 640 L240 640 Q180 640 180 600 Z" fill="url(#sub-${id})"/>
        <path d="M380 460 L420 420 L500 460 Z" fill="${p[4]}" opacity=".7"/>
        <circle cx="280" cy="600" r="14" fill="${p[3]}"/>
        <circle cx="540" cy="600" r="14" fill="${p[3]}"/>
      ` },
    { kind:'chair', draw: (id, p) => `
        <rect x="290" y="240" width="220" height="240" rx="10" fill="url(#sub-${id})"/>
        <rect x="290" y="460" width="220" height="40" fill="${p[4]}" opacity=".7"/>
        <rect x="300" y="500" width="20" height="160" fill="${p[3]}"/>
        <rect x="480" y="500" width="20" height="160" fill="${p[3]}"/>
      ` },
    { kind:'ceramic', draw: (id, p) => `
        <path d="M310 360 Q310 280 400 280 Q490 280 490 360 L520 600 Q520 660 400 660 Q280 660 280 600 Z" fill="url(#sub-${id})"/>
        <ellipse cx="400" cy="360" rx="90" ry="20" fill="${p[3]}" opacity=".6"/>
      ` },
    { kind:'fruit', draw: (id, p) => `
        <circle cx="350" cy="450" r="120" fill="url(#sub-${id})"/>
        <circle cx="470" cy="500" r="100" fill="${p[2]}"/>
        <path d="M340 320 Q360 280 400 290" stroke="${p[3]}" stroke-width="6" fill="none" stroke-linecap="round"/>
      ` },
  ];

  // Build one full SVG (original photo)
  function buildOriginal(idx, name, opts={}){
    const palette = PALETTES[idx % PALETTES.length];
    const subject = SUBJECTS[idx % SUBJECTS.length];
    const subId = `s${idx}`;
    const noiseId = `n${idx}`;
    const grainOpacity = 0.18;

    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg-${idx}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${palette[0]}"/>
      <stop offset="1" stop-color="${palette[1]}"/>
    </linearGradient>
    <linearGradient id="sub-${subId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette[2]}"/>
      <stop offset="1" stop-color="${palette[3]}"/>
    </linearGradient>
    <radialGradient id="vig-${idx}" cx="0.5" cy="0.45" r="0.75">
      <stop offset="0.55" stop-color="rgba(0,0,0,0)"/>
      <stop offset="1" stop-color="rgba(0,0,0,0.55)"/>
    </radialGradient>
    <pattern id="${noiseId}" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="rgba(255,255,255,0.02)"/>
      <circle cx="1" cy="1" r="0.5" fill="rgba(255,255,255,0.06)"/>
      <circle cx="4" cy="3" r="0.5" fill="rgba(0,0,0,0.06)"/>
    </pattern>
  </defs>
  <rect width="800" height="800" fill="url(#bg-${idx})"/>
  <!-- subtle bg shapes -->
  <circle cx="${120 + (idx*73)%400}" cy="${140 + (idx*51)%200}" r="${60 + (idx*13)%80}" fill="${palette[4]}" opacity="0.06"/>
  <rect x="${500 + (idx*23)%160}" y="${600 + (idx*17)%120}" width="180" height="180" fill="${palette[4]}" opacity="0.05"/>
  ${subject.draw(subId, palette)}
  <rect width="800" height="800" fill="url(#${noiseId})" opacity="${grainOpacity}"/>
  <rect width="800" height="800" fill="url(#vig-${idx})"/>
</svg>`;
  }

  // Build the cutout version: same subject on transparent (we'll render the checker via CSS).
  function buildCutout(idx, threshold=50, feather=10){
    const palette = PALETTES[idx % PALETTES.length];
    const subject = SUBJECTS[idx % SUBJECTS.length];
    const subId = `c${idx}_${threshold}_${feather}`;
    // map threshold (0-100) to "tightness" of edge crop -- visualize by a slight inset / outset
    // map feather (0-100) to gaussian blur stdDeviation
    const blur = (feather/100) * 6; // 0-6 px
    // threshold doesn't really change geometry in placeholder land, but we can fake it
    // by clipping a tiny outline halo when threshold is low.
    const halo = Math.max(0, (50 - threshold) * 0.6); // 0-30
    const haloOpacity = halo/40;

    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="sub-${subId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette[2]}"/>
      <stop offset="1" stop-color="${palette[3]}"/>
    </linearGradient>
    <filter id="f-${subId}" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="${blur}"/>
    </filter>
    <filter id="halo-${subId}" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
  </defs>
  ${haloOpacity > 0.01 ? `<g filter="url(#halo-${subId})" opacity="${haloOpacity.toFixed(2)}">${subject.draw(subId+'_h', palette)}</g>` : ''}
  <g filter="url(#f-${subId})">
    ${subject.draw(subId, palette)}
  </g>
</svg>`;
  }

  function dataUri(svg){
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim());
  }

  function makeImage(idx, name){
    return {
      id: `img-${idx}`,
      idx,
      name,
      width: 4032,
      height: 4032,
      kind: SUBJECTS[idx % SUBJECTS.length].kind,
      original: dataUri(buildOriginal(idx, name)),
      cutout: (threshold, feather) => dataUri(buildCutout(idx, threshold, feather)),
      processed: false,  // start un-processed — user must detect first
    };
  }

  const FILENAMES = [
    'IMG_4821',
    'studio_03',
    'product_hero',
    'lookbook_07',
    'archive_22',
    'shoot_b_14',
    'flatlay_01',
    'editorial_08',
    'campaign_v2',
    'pdp_main_05',
    'still_life_11',
    'capsule_03',
    'archive_31',
    'web_thumb_06',
  ];

  window.PLACEHOLDERS = {
    make: makeImage,
    filenames: FILENAMES,
    palettes: PALETTES,
  };
})();
