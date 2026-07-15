/* ============================================================
   pricebook — client-side unit-price comparator + price log.
   No network. No dependencies. State in localStorage.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny helpers ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uid() {
    return "p" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  /* ============================================================
     UNIT MODEL — the verified core.
     Weights normalise to price per 100 g; volumes to per litre;
     counts to per each. Same family -> one base unit first, so
     g and kg (or ml and L) compare fairly.
     ============================================================ */
  var UNITS = {
    g:    { family: "weight", toBase: 1,    label: "g"  },
    kg:   { family: "weight", toBase: 1000, label: "kg" },
    ml:   { family: "volume", toBase: 1,    label: "ml" },
    l:    { family: "volume", toBase: 1000, label: "L"  },
    each: { family: "count",  toBase: 1,    label: "each" }
  };
  var BASIS = {
    weight: { per: 100,  label: "/100 g" },
    volume: { per: 1000, label: "/L" },
    count:  { per: 1,    label: "/each" }
  };

  // Returns { unitPrice, family, basisLabel } or null on invalid input.
  function unitPrice(price, size, unitKey) {
    var u = UNITS[unitKey];
    if (!u) return null;
    if (!(price >= 0) || !(size > 0)) return null;
    var baseQty = size * u.toBase;         // to grams / millilitres / each
    var b = BASIS[u.family];
    var perBase = price / baseQty;         // price per 1 base unit
    return { unitPrice: perBase * b.per, family: u.family, basisLabel: b.label };
  }

  /* ---------- money formatting ---------- */
  function fmtMoney(n) {
    if (!isFinite(n)) return "—";
    // up to 2 decimals for whole-ish, up to 4 for tiny per-unit values
    var abs = Math.abs(n);
    var dp = abs >= 1 ? 2 : (abs >= 0.1 ? 3 : 4);
    var s = n.toFixed(dp);
    // trim trailing zeros but keep at least 2 dp
    s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    var parts = s.split(".");
    if (!parts[1]) parts[1] = "00";
    else if (parts[1].length === 1) parts[1] += "0";
    // thousands separators on the integer part
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return "";
    var s = String(n);
    if (s.indexOf(".") >= 0) s = String(parseFloat(n.toFixed(4)));
    return s;
  }

  /* ============================================================
     STATE — persisted store
     store = { v, products: [ { id, name, category, currency,
        options: [ { id, brand, store, size, unit,
          log: [ { price, date } ] } ] } ] }
     ============================================================ */
  var KEY = "pricebook:v1";
  var storageOk = true;
  var store = { v: 1, products: [] };

  function load() {
    try {
      localStorage.setItem("pricebook:test", "1");
      localStorage.removeItem("pricebook:test");
    } catch (e) { storageOk = false; return; }
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.products)) store = parsed;
      }
    } catch (e) { store = { v: 1, products: [] }; }
  }
  function save() {
    if (!storageOk) return;
    try { localStorage.setItem(KEY, JSON.stringify(store)); }
    catch (e) { storageOk = false; }
  }

  function findProduct(id) {
    for (var i = 0; i < store.products.length; i++) if (store.products[i].id === id) return store.products[i];
    return null;
  }
  function findOption(product, oid) {
    for (var i = 0; i < product.options.length; i++) if (product.options[i].id === oid) return product.options[i];
    return null;
  }

  /* current (latest) price of an option = last log entry */
  function currentPrice(opt) {
    if (!opt.log || !opt.log.length) return null;
    return opt.log[opt.log.length - 1].price;
  }
  function optionUnit(opt) {
    var p = currentPrice(opt);
    if (p == null) return null;
    return unitPrice(p, opt.size, opt.unit);
  }

  /* Cheapest option within a product, comparing only within the same
     unit family. If options span multiple families we pick the best
     within each family and mark the overall min per family. */
  function bestOptionId(product) {
    var best = null, bestVal = Infinity;
    product.options.forEach(function (o) {
      var up = optionUnit(o);
      if (up && up.unitPrice < bestVal) { bestVal = up.unitPrice; best = o.id; }
    });
    // Only crown a single best if all priced options share one family.
    var fams = {};
    product.options.forEach(function (o) {
      var up = optionUnit(o);
      if (up) fams[up.family] = true;
    });
    if (Object.keys(fams).length > 1) return null; // mixed families: no single winner
    return best;
  }

  /* ============================================================
     DATALISTS (categories, stores) — from existing data
     ============================================================ */
  function refreshDatalists() {
    var cats = {}, stores = {};
    store.products.forEach(function (p) {
      if (p.category) cats[p.category] = true;
      p.options.forEach(function (o) { if (o.store) stores[o.store] = true; });
    });
    fillDatalist("catList", Object.keys(cats).sort());
    fillDatalist("storeList", Object.keys(stores).sort());
  }
  function fillDatalist(id, values) {
    var dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = "";
    values.forEach(function (v) { var o = el("option"); o.value = v; dl.appendChild(o); });
  }

  /* ============================================================
     RENDER
     ============================================================ */
  var viewSort = "recent";
  var viewFilter = "";
  var openLogFor = {};    // optionId -> bool (price log expanded)
  var addingOptFor = null; // productId currently showing add-option form

  function matchesFilter(p) {
    if (!viewFilter) return true;
    var hay = (p.name + " " + (p.category || "") + " " +
      p.options.map(function (o) { return (o.brand || "") + " " + (o.store || ""); }).join(" ")).toLowerCase();
    return hay.indexOf(viewFilter) >= 0;
  }

  function sortedProducts() {
    var list = store.products.filter(matchesFilter);
    if (viewSort === "name") {
      list = list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else if (viewSort === "category") {
      list = list.slice().sort(function (a, b) {
        return (a.category || "~").localeCompare(b.category || "~") || a.name.localeCompare(b.name);
      });
    } else {
      // recent = original order reversed (newest first, since we push)
      list = list.slice().reverse();
    }
    return list;
  }

  function render() {
    refreshDatalists();
    renderStat();
    renderProducts();
    renderCompare();
    var empty = $("#empty");
    empty.hidden = store.products.length > 0;
  }

  function renderStat() {
    var np = store.products.length;
    var no = 0, ne = 0;
    store.products.forEach(function (p) {
      no += p.options.length;
      p.options.forEach(function (o) { ne += (o.log ? o.log.length : 0); });
    });
    var stat = $("#bookStat");
    if (np === 0) { stat.textContent = "No products yet."; return; }
    stat.innerHTML = "";
    stat.appendChild(el("b", null, String(np)));
    stat.appendChild(document.createTextNode(" " + (np === 1 ? "product" : "products") + ", "));
    stat.appendChild(el("b", null, String(no)));
    stat.appendChild(document.createTextNode(" " + (no === 1 ? "option" : "options") + ", "));
    stat.appendChild(el("b", null, String(ne)));
    stat.appendChild(document.createTextNode(" logged " + (ne === 1 ? "price" : "prices") + "."));
  }

  function renderProducts() {
    var root = $("#products");
    root.innerHTML = "";
    sortedProducts().forEach(function (p) { root.appendChild(productCard(p)); });
  }

  function productCard(p) {
    var card = el("section", "product");
    card.dataset.id = p.id;
    card.setAttribute("aria-label", p.name);

    var head = el("div", "product__head");
    var titles = el("div", "product__titles");
    titles.appendChild(el("h3", "product__name", p.name));
    if (p.category) titles.appendChild(el("span", "product__cat", p.category));

    var bestId = bestOptionId(p);
    var bestLine = el("p", "product__best");
    if (bestId) {
      var bo = findOption(p, bestId);
      var up = optionUnit(bo);
      bestLine.appendChild(document.createTextNode("Best value: "));
      var who = (bo.brand || "option") + (bo.store ? " @ " + bo.store : "");
      bestLine.appendChild(el("b", null, p.currency + fmtMoney(up.unitPrice) + " " + up.basisLabel));
      bestLine.appendChild(document.createTextNode(" — " + who));
    } else if (p.options.length > 1) {
      bestLine.textContent = "Options span different unit types — compared within each type.";
    } else if (p.options.length === 1 && optionUnit(p.options[0])) {
      bestLine.textContent = "Add another option to compare.";
    } else {
      bestLine.textContent = "Add a price to see the unit cost.";
    }
    titles.appendChild(bestLine);
    head.appendChild(titles);

    var actions = el("div", "product__actions");
    var addOptBtn = el("button", "btn btn--small btn--ghost", "Add option");
    addOptBtn.type = "button";
    addOptBtn.addEventListener("click", function () {
      addingOptFor = (addingOptFor === p.id) ? null : p.id;
      render();
    });
    actions.appendChild(addOptBtn);
    var delBtn = el("button", "btn btn--small btn--danger", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", function () {
      if (confirm("Delete “" + p.name + "” and all its options?")) {
        store.products = store.products.filter(function (x) { return x.id !== p.id; });
        save(); render();
      }
    });
    actions.appendChild(delBtn);
    head.appendChild(actions);
    card.appendChild(head);

    var list = el("ul", "opts");
    // order options cheapest-first (within priced ones)
    var ordered = p.options.slice().sort(function (a, b) {
      var ua = optionUnit(a), ub = optionUnit(b);
      var va = ua ? ua.unitPrice : Infinity, vb = ub ? ub.unitPrice : Infinity;
      return va - vb;
    });
    ordered.forEach(function (o) { list.appendChild(optionRow(p, o, o.id === bestId)); });

    if (addingOptFor === p.id) {
      list.appendChild(buildAddOptForm(p));
    }
    card.appendChild(list);
    return card;
  }

  function optionRow(p, o, isBest) {
    var li = el("li", "opt" + (isBest ? " is-best" : ""));
    li.dataset.id = o.id;

    var idcol = el("div", "opt__id");
    idcol.appendChild(el("span", "opt__brand", o.brand || "(unbranded)"));
    if (o.store) idcol.appendChild(el("div", "opt__where", o.store));
    li.appendChild(idcol);

    var pack = el("span", "opt__pack");
    var u = UNITS[o.unit];
    var cur = currentPrice(o);
    pack.appendChild(document.createTextNode(fmtNum(o.size) + " " + (u ? u.label : o.unit)));
    var sep = el("span", "sep", "·");
    pack.appendChild(sep);
    pack.appendChild(document.createTextNode(cur == null ? "no price" : p.currency + fmtMoney(cur)));
    li.appendChild(pack);

    var unitCol = el("div", "opt__unit");
    var up = optionUnit(o);
    if (up) {
      unitCol.appendChild(el("span", "unitprice", p.currency + fmtMoney(up.unitPrice)));
      unitCol.appendChild(el("span", "unitprice__basis", up.basisLabel));
    } else {
      unitCol.appendChild(el("span", "unitprice__basis", "—"));
    }
    li.appendChild(unitCol);

    if (isBest) li.appendChild(el("span", "badge--best", "best value"));

    // tools row
    var tools = el("div", "opt__tools");
    var logBtn = el("button", "linkbtn", (openLogFor[o.id] ? "Hide" : "Show") + " price log" +
      (o.log && o.log.length ? " (" + o.log.length + ")" : ""));
    logBtn.type = "button";
    logBtn.addEventListener("click", function () { openLogFor[o.id] = !openLogFor[o.id]; render(); });
    tools.appendChild(logBtn);

    var rmBtn = el("button", "linkbtn linkbtn--danger", "Remove option");
    rmBtn.type = "button";
    rmBtn.addEventListener("click", function () {
      p.options = p.options.filter(function (x) { return x.id !== o.id; });
      save(); render();
    });
    tools.appendChild(rmBtn);
    li.appendChild(tools);

    if (openLogFor[o.id]) li.appendChild(priceLog(p, o));
    return li;
  }

  function priceLog(p, o) {
    var wrap = el("div", "pricelog");
    var head = el("div", "pricelog__head");
    head.appendChild(el("span", "pricelog__title", "Price log"));
    wrap.appendChild(head);

    var entries = (o.log || []).slice();
    if (entries.length) {
      var prices = entries.map(function (e) { return e.price; });
      var lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
      var span = hi - lo;
      var ul = el("ul", "pricelog__list");
      // show chronological
      entries.forEach(function (e) {
        var row = el("li", "logentry");
        row.appendChild(el("span", "logentry__date", e.date));
        var spark = el("span", "logentry__spark");
        var frac = span > 0 ? (e.price - lo) / span : 0;
        spark.style.width = (20 + frac * 80) + "%";
        if (e.price === lo && span > 0) spark.classList.add("is-low");
        else if (e.price === hi && span > 0) spark.classList.add("is-high");
        row.appendChild(spark);
        row.appendChild(el("span", "logentry__price", p.currency + fmtMoney(e.price)));
        ul.appendChild(row);
      });
      wrap.appendChild(ul);

      // trend line
      if (entries.length >= 2) {
        var first = entries[0].price, last = entries[entries.length - 1].price;
        var diff = last - first;
        var trend = el("p", "logtrend");
        if (diff === 0) {
          trend.textContent = "Unchanged across " + entries.length + " entries.";
        } else {
          var pct = first > 0 ? Math.round((diff / first) * 100) : 0;
          trend.appendChild(document.createTextNode((diff > 0 ? "Up " : "Down ")));
          trend.appendChild(el("b", null, p.currency + fmtMoney(Math.abs(diff)) + (pct ? " (" + Math.abs(pct) + "%)" : "")));
          trend.appendChild(document.createTextNode(" since first logged; lowest seen " + p.currency + fmtMoney(lo) + "."));
        }
        wrap.appendChild(trend);
      }
    } else {
      wrap.appendChild(el("p", "logtrend", "No prices logged yet — add one below."));
    }

    // add-price mini form
    var addForm = el("form", "logadd");
    var pf = el("div", "field field--num");
    pf.appendChild(el("label", null, "New price"));
    var priceInput = el("input");
    priceInput.type = "number"; priceInput.min = "0"; priceInput.step = "any";
    priceInput.setAttribute("inputmode", "decimal");
    priceInput.placeholder = currentPrice(o) != null ? fmtNum(currentPrice(o)) : "0";
    pf.appendChild(priceInput);
    addForm.appendChild(pf);

    var df = el("div", "field field--num");
    df.appendChild(el("label", null, "Date"));
    var dateInput = el("input");
    dateInput.type = "date";
    dateInput.value = todayISO();
    df.appendChild(dateInput);
    addForm.appendChild(df);

    var saveBtn = el("button", "btn btn--small btn--primary", "Log price");
    saveBtn.type = "submit";
    addForm.appendChild(saveBtn);

    addForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var val = parseFloat(priceInput.value);
      if (!(val >= 0)) { priceInput.focus(); return; }
      if (!o.log) o.log = [];
      o.log.push({ price: val, date: dateInput.value || todayISO() });
      // keep log sorted by date ascending so "current" = latest date
      o.log.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
      touch(p);
      save(); render();
    });
    wrap.appendChild(addForm);
    return wrap;
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }
  function touch(p) { p.updated = Date.now(); }

  /* ---------- add-option inline form (from template) ---------- */
  function buildAddOptForm(p) {
    var tpl = $("#optionFormTpl");
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.addEventListener("submit", function (e) {
      e.preventDefault();
      var size = parseFloat(fieldVal(node, "size"));
      var price = parseFloat(fieldVal(node, "price"));
      var unit = fieldVal(node, "unit");
      if (!(size > 0)) { focusField(node, "size"); return; }
      var opt = {
        id: uid(),
        brand: fieldVal(node, "brand").trim(),
        store: fieldVal(node, "store").trim(),
        size: size,
        unit: unit,
        log: []
      };
      if (price >= 0 && fieldVal(node, "price") !== "") {
        opt.log.push({ price: price, date: todayISO() });
      }
      p.options.push(opt);
      touch(p);
      addingOptFor = null;
      save(); render();
    });
    node.querySelector('[data-a="cancel"]').addEventListener("click", function () {
      addingOptFor = null; render();
    });
    return node;
  }
  function fieldVal(root, name) { var f = root.querySelector('[data-f="' + name + '"]'); return f ? f.value : ""; }
  function focusField(root, name) { var f = root.querySelector('[data-f="' + name + '"]'); if (f) f.focus(); }

  /* ============================================================
     COMPARE STRIP — surfaces the product with the most options
     ============================================================ */
  function renderCompare() {
    var sect = $("#compare");
    var grid = $("#compareGrid");
    grid.innerHTML = "";
    // choose the (filtered) product with the most priced options
    var candidate = null, mostPriced = 0;
    sortedProducts().forEach(function (p) {
      var priced = p.options.filter(function (o) { return optionUnit(o); }).length;
      if (priced > mostPriced) { mostPriced = priced; candidate = p; }
    });
    if (!candidate || mostPriced < 2) { sect.hidden = true; return; }
    sect.hidden = false;
    $(".compare__title").textContent = "Compare: " + candidate.name;

    var bestId = bestOptionId(candidate);
    var ordered = candidate.options
      .filter(function (o) { return optionUnit(o); })
      .sort(function (a, b) { return optionUnit(a).unitPrice - optionUnit(b).unitPrice; });

    ordered.forEach(function (o) {
      var up = optionUnit(o);
      var c = el("div", "ccard" + (o.id === bestId ? " is-best" : ""));
      c.appendChild(el("div", "ccard__label", (o.brand || "(unbranded)")));
      c.appendChild(el("div", "ccard__meta", (o.store || "—")));
      c.appendChild(el("div", "ccard__unit", candidate.currency + fmtMoney(up.unitPrice) + " " + up.basisLabel));
      var u = UNITS[o.unit];
      c.appendChild(el("div", "ccard__pack", fmtNum(o.size) + " " + (u ? u.label : o.unit) + " @ " + candidate.currency + fmtMoney(currentPrice(o))));
      grid.appendChild(c);
    });
  }

  /* ============================================================
     CSV EXPORT (RFC 4180)
     ============================================================ */
  function csvField(v) {
    var s = (v == null) ? "" : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function buildCSV() {
    var rows = [];
    rows.push(["product", "category", "currency", "brand", "store",
      "pack_size", "unit", "price_date", "price", "unit_price", "unit_basis", "is_best_value"]);
    store.products.forEach(function (p) {
      var bestId = bestOptionId(p);
      p.options.forEach(function (o) {
        var up = optionUnit(o);
        var basis = up ? up.basisLabel.replace(/^\//, "per ") : "";
        var log = (o.log && o.log.length) ? o.log : [{ price: "", date: "" }];
        log.forEach(function (e) {
          // recompute unit price at each logged price for that row
          var rowUp = "";
          if (e.price !== "" && e.price != null) {
            var calc = unitPrice(e.price, o.size, o.unit);
            if (calc) rowUp = calc.unitPrice.toFixed(4);
          }
          rows.push([
            p.name, p.category || "", p.currency,
            o.brand || "", o.store || "",
            o.size, UNITS[o.unit] ? UNITS[o.unit].label : o.unit,
            e.date || "", e.price,
            rowUp, basis,
            (o.id === bestId ? "yes" : "")
          ]);
        });
      });
    });
    return rows.map(function (r) { return r.map(csvField).join(","); }).join("\r\n") + "\r\n";
  }
  function exportCSV() {
    if (!store.products.length) { alert("Nothing to export yet — add a product first."); return; }
    var csv = buildCSV();
    // data: URI keeps us inside CSP (no blob:/network needed)
    var uri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    var a = document.createElement("a");
    a.href = uri;
    a.download = "pricebook-" + todayISO() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ============================================================
     COMPOSER (add product)
     ============================================================ */
  function onAddProduct(e) {
    e.preventDefault();
    var name = $("#pName").value.trim();
    if (!name) { $("#pName").focus(); return; }
    var currency = $("#pCurrency").value.trim() || "₹";
    var product = {
      id: uid(),
      name: name,
      category: $("#pCategory").value.trim(),
      currency: currency,
      updated: Date.now(),
      options: []
    };
    var size = parseFloat($("#oSize").value);
    var price = parseFloat($("#oPrice").value);
    var unit = $("#oUnit").value;
    if (size > 0) {
      var opt = { id: uid(), brand: $("#oBrand").value.trim(), store: $("#oStore").value.trim(), size: size, unit: unit, log: [] };
      if (price >= 0 && $("#oPrice").value !== "") opt.log.push({ price: price, date: todayISO() });
      product.options.push(opt);
    }
    store.products.push(product);
    save();
    // reset the option fields but keep currency + category for the next add
    $("#pName").value = ""; $("#oBrand").value = ""; $("#oStore").value = "";
    $("#oSize").value = ""; $("#oPrice").value = "";
    render();
    $("#pName").focus();
  }

  /* ============================================================
     SHELF-TAG WEAVE SIGNATURE (hero)
     ============================================================ */
  function renderWeave() {
    var g = $(".weave__tags");
    if (!g) return;
    var W = 1500, H = 360;
    var frag = document.createDocumentFragment();
    // rows of little price-tags (rounded rects with a punch hole) drawn as paths
    var tagW = 84, tagH = 42, gapX = 128, gapY = 96;
    for (var row = 0; row * gapY < H + gapY; row++) {
      var offset = (row % 2) * (gapX / 2);
      for (var x = -tagW; x < W; x += gapX) {
        var px = x + offset;
        var py = row * gapY + 30;
        // tag body: notch on the left like a luggage/price tag
        var d = "M " + (px + 14) + " " + py +
          " L " + (px + tagW) + " " + py +
          " L " + (px + tagW) + " " + (py + tagH) +
          " L " + (px + 14) + " " + (py + tagH) +
          " L " + px + " " + (py + tagH / 2) + " Z";
        var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        p.setAttribute("opacity", (0.25 + ((row + x) % 3) * 0.12).toFixed(2));
        frag.appendChild(p);
        // punch hole
        var hole = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        hole.setAttribute("cx", px + 24); hole.setAttribute("cy", py + tagH / 2);
        hole.setAttribute("r", "4");
        frag.appendChild(hole);
      }
    }
    g.appendChild(frag);
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    load();
    $("#composer").addEventListener("submit", onAddProduct);
    $("#exportBtn").addEventListener("click", exportCSV);
    $("#search").addEventListener("input", function () {
      viewFilter = this.value.trim().toLowerCase(); render();
    });
    $("#sortSel").addEventListener("change", function () { viewSort = this.value; render(); });

    if (!storageOk) {
      var stat = $("#bookStat");
      if (stat) stat.textContent = "Storage is unavailable — data won't persist between visits.";
    }
    renderWeave();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
