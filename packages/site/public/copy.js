// Copy-the-command interaction. No build step and no framework — the page is
// one panel, so a script tag is the whole client.

(function () {
  var btn = document.getElementById("copy");
  var cmd = document.getElementById("cmd");
  var revert = null;

  // navigator.clipboard needs a secure context. That covers production and
  // `wrangler dev` on localhost, but a page opened over plain http:// from a
  // LAN address would have no clipboard at all — hence the textarea fallback.
  function write(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  btn.addEventListener("click", function () {
    write(btn.getAttribute("data-command")).then(
      function () {
        btn.textContent = "Copied";
        btn.classList.add("done");
      },
      function () {
        // Selecting the text is the honest fallback: the user copies it.
        btn.textContent = "Press ⌘C";
        var range = document.createRange();
        range.selectNodeContents(cmd);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      },
    );

    clearTimeout(revert);
    revert = setTimeout(function () {
      btn.textContent = "Copy";
      btn.classList.remove("done");
    }, 1800);
  });
})();
