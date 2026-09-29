// ---------- 지도 위 눈 내리는 배경 효과 ----------
// 지도 위에 캔버스를 한 장 덮고 눈송이를 떨어뜨린다. pointer-events: none 이라 지도 조작은 막지 않는다.

(() => {
  const COUNT = 120;          // 눈송이 개수
  const canvas = document.createElement("canvas");
  canvas.id = "snow";
  canvas.style.cssText = "position:absolute; inset:0; z-index:1200; pointer-events:none;";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const rand = (min, max) => min + Math.random() * (max - min);
  let flakes = [];

  const reset = f => {
    f.x = rand(0, canvas.width);
    f.y = rand(-canvas.height, 0);
    f.r = rand(1, 3.5);              // 반지름
    f.fall = rand(0.4, 1.4);         // 떨어지는 속도
    f.drift = rand(-0.4, 0.4);       // 좌우로 흐르는 정도
    f.alpha = rand(0.35, 0.9);
    return f;
  };

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    flakes = Array.from({ length: COUNT }, () => reset({}));
  };

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const f of flakes) {
      f.y += f.fall;
      f.x += f.drift;
      if (f.y > canvas.height + f.r) { reset(f); f.y = -f.r; }
      if (f.x < -f.r) f.x = canvas.width + f.r;
      if (f.x > canvas.width + f.r) f.x = -f.r;

      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${f.alpha})`;
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };

  window.addEventListener("resize", resize);
  resize();
  draw();
})();
