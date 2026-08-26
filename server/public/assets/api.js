window.TC = window.TC || {};
(function(){
  "use strict";

  TC.api = async function(path, opts){
    opts = opts || {};
    var res = await fetch(path.indexOf("/api") === 0 ? path : "/api" + path, {
      method: opts.method || "GET",
      headers: Object.assign({ "X-Requested-With": "fetch" }, opts.body ? { "Content-Type": "application/json" } : {}),
      credentials: "same-origin",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var json = null;
    try{
      json = await res.json();
    }catch(e){
      json = null;
    }
    if(res.status === 401 && TC.alLogin && location.pathname.indexOf("login.html") === -1){
      location.href = "/login.html";
    }
    if(!res.ok || !json || json.ok === false){
      var err = new Error((json && json.error && json.error.message) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    var data = json.data;
    if(data && typeof data === "object" && !Array.isArray(data)){
      var keys = Object.keys(data);
      if(keys.length === 1 && Array.isArray(data[keys[0]])){
        data = data[keys[0]];
      }
    }
    return data;
  };

  var copFmt = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
  TC.formatCOP = function(n){
    return copFmt.format(n);
  };

  TC.esc = function(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var toastEl = null;
  var toastTimer = null;

  TC.toast = function(msg, tipo){
    if(!toastEl){
      toastEl = document.createElement("div");
      toastEl.id = "tc-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      toastEl.className = "fixed bottom-5 left-1/2 z-50 flex max-w-sm -translate-x-1/2 items-center gap-2.5 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-2xl opacity-0 pointer-events-none translate-y-2 transition-all duration-300";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = String(msg == null ? "" : msg);
    toastEl.classList.toggle("bg-emerald-600", tipo !== "error");
    toastEl.classList.toggle("bg-rose-600", tipo === "error");
    requestAnimationFrame(function(){
      toastEl.classList.remove("opacity-0", "translate-y-2");
    });
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){
      toastEl.classList.add("opacity-0", "translate-y-2");
    }, tipo === "error" ? 4200 : 3000);
  };
})();
