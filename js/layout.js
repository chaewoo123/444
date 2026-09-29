// 공통 헤더를 페이지 맨 위에 끼워 넣는다.
// 메뉴를 고치려면 아래 PAGES 만 바꾸면 모든 페이지에 반영된다.
(function () {
  const PAGES = [
    { href: "index.html", label: "지도" },
    { href: "density-dashboard.html", label: "대시보드" },
    { href: "evidence.html", label: "근거값 기록부" },
  ];
  // 게시판은 아직 없어서 버튼만 보여 준다 (board.html 이 생기면 ready: true)
  const BOARD = { href: "board.html", label: "게시판", ready: false };

  const file = location.pathname.split("/").pop() || "index.html";
  const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const link = (p, cls = "") => {
    const cur = p.href === file ? ' aria-current="page"' : "";
    if (p.ready === false) {
      return `<a class="${cls}" aria-disabled="true" title="준비 중"${cur}>${esc(p.label)}</a>`;
    }
    return `<a class="${cls}" href="${p.href}"${cur}>${esc(p.label)}</a>`;
  };

  const header = document.createElement("div");
  header.className = "gs-header";
  header.setAttribute("role", "banner");
  header.innerHTML =
    `<a class="gs-brand" href="index.html">Green Smart</a>` +
    `<nav aria-label="사이트 메뉴"><ul class="gs-menu">` +
    PAGES.map(p => `<li>${link(p)}</li>`).join("") +
    `<li>${link(BOARD, "gs-cta")}</li>` +
    `</ul></nav>`;

  document.body.prepend(header);
})();
