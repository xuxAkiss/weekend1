/**
 * app.js — 应用主逻辑
 * 依赖：kmeans.js（全局函数）、ECharts（CDN）
 * 负责：DOM 交互、图片处理、图表渲染、AI 分析
 */
(function () {
  "use strict";

  // ==================== DOM 引用 ====================
  var fileInput      = document.getElementById("fileInput");
  var dropZone       = document.getElementById("dropZone");
  var fileNameEl     = document.getElementById("fileName");
  var previewCard    = document.getElementById("previewCard");
  var sourceCanvas   = document.getElementById("sourceCanvas");
  var previewCanvas  = document.getElementById("previewCanvas");
  var imageInfo      = document.getElementById("imageInfo");
  var controlCard    = document.getElementById("controlCard");
  var kSlider        = document.getElementById("kSlider");
  var kValueInput    = document.getElementById("kValue");
  var maxIterInput   = document.getElementById("maxIter");
  var colorSpaceSel  = document.getElementById("colorSpaceSel");
  var runBtn         = document.getElementById("runBtn");
  var chartTypeBtns  = document.querySelectorAll(".chart-type-btn");
  var resultCard     = document.getElementById("resultCard");
  var resultBody     = document.getElementById("resultBody");
  var chartContainer = document.getElementById("chartContainer");
  var logCard        = document.getElementById("logCard");
  var logArea        = document.getElementById("logArea");
  var aiCard         = document.getElementById("aiCard");
  var aiEndpoint     = document.getElementById("aiEndpoint");
  var aiKey          = document.getElementById("aiKey");
  var aiModel        = document.getElementById("aiModel");
  var aiRunBtn       = document.getElementById("aiRunBtn");
  var aiResult       = document.getElementById("aiResult");
  var aiStatus       = document.getElementById("aiStatus");

  // ==================== 全局状态 ====================
  var imageImageData   = null;
  var imageWidth       = 0;
  var imageHeight      = 0;
  var chartInstance    = null;
  var lastResult       = null;     // 最近一次聚类结果
  var lastSampledCount = 0;        // 采样像素数（用于百分比计算）
  var currentChartType = "pie";    // pie | bar | rose
  var clusteringTimer  = null;     // debounce 定时器

  // ==================== 工具函数 ====================

  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(function (v) {
      return ("0" + Math.round(v).toString(16)).slice(-2);
    }).join("");
  }

  function log(msg) {
    logCard.style.display = "block";
    logArea.textContent += "[" + new Date().toLocaleTimeString() + "] " + msg + "\n";
    logArea.scrollTop = logArea.scrollHeight;
  }

  function debounce(fn, delay) {
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(clusteringTimer);
      clusteringTimer = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  }

  // ==================== 图片加载 ====================

  /**
   * 加载图片文件 → 绘制到 Canvas → 提取 ImageData → 自动聚类
   */
  function loadImageFile(file) {
    if (!file || !file.type.match(/image\//)) return;

    fileNameEl.textContent = file.name;
    log("📂 已选择文件：" + file.name + "（" + (file.size / 1024).toFixed(1) + " KB）");

    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        imageWidth  = img.naturalWidth;
        imageHeight = img.naturalHeight;

        // 原图 Canvas（隐藏）—— 提取 ImageData
        sourceCanvas.width  = imageWidth;
        sourceCanvas.height = imageHeight;
        var sctx = sourceCanvas.getContext("2d");
        sctx.drawImage(img, 0, 0);
        imageImageData = sctx.getImageData(0, 0, imageWidth, imageHeight);

        // 预览 Canvas
        var MAX_W = 300, MAX_H = 250;
        var pw = imageWidth, ph = imageHeight;
        if (pw > MAX_W || ph > MAX_H) {
          var scale = Math.min(MAX_W / pw, MAX_H / ph);
          pw = Math.round(pw * scale);
          ph = Math.round(ph * scale);
        }
        previewCanvas.width  = pw;
        previewCanvas.height = ph;
        var pctx = previewCanvas.getContext("2d");
        pctx.drawImage(img, 0, 0, pw, ph);

        imageInfo.innerHTML =
          "📐 原始尺寸：" + imageWidth + " × " + imageHeight +
          "<br>🔢 像素总数：" + (imageWidth * imageHeight).toLocaleString() +
          "<br>📋 可用通道：RGBA（算法使用 RGB）";

        previewCard.style.display = "block";
        controlCard.style.display = "block";

        log("✅ 图片加载完成，" + imageWidth + "×" + imageHeight +
            "，共 " + (imageWidth * imageHeight).toLocaleString() + " 个像素");

        // 自动运行聚类
        runClustering();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ---- 文件选择 ----
  fileInput.addEventListener("change", function (e) {
    if (e.target.files[0]) loadImageFile(e.target.files[0]);
  });

  // ---- 拖拽上传 ----
  dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
  });

  // ==================== 聚类流水线 ====================

  function runClustering() {
    if (!imageImageData) return;

    // 清空
    logArea.textContent = "";
    resultBody.innerHTML = "";
    aiResult.textContent = "";
    aiStatus.textContent = "";

    var K       = parseInt(kValueInput.value, 10);
    var maxIter = parseInt(maxIterInput.value, 10);
    var colorSpace = colorSpaceSel.value; // "rgb" | "lab"

    log("══════ 开始 K-means 聚类 ══════");
    log("参数：K = " + K + "，最大迭代 = " + maxIter + "，色彩空间 = " + colorSpace.toUpperCase());

    // 提取像素
    var MAX_PIXELS = 50000;
    var extracted = extractPixels(imageImageData, MAX_PIXELS);
    var pixels = extracted.pixels;
    var stride = extracted.stride;
    var totalActual = extracted.totalActual;

    if (stride > 1) {
      log("⚠️ 原始像素 " + totalActual.toLocaleString() +
          " 超过上限，降采样至 " + pixels.length.toLocaleString() + "（步长=" + stride + "）");
    } else {
      log("📊 共 " + pixels.length.toLocaleString() + " 个像素");
    }

    // 若选择 LAB 空间，先转换所有像素
    var clusterPixels = pixels;
    if (colorSpace === "lab") {
      log("🔄 正在将像素从 RGB 转换到 LAB 空间...");
      clusterPixels = pixels.map(function (p) { return rgbToLab(p); });
    }

    // 选择距离函数
    var distFn = colorSpace === "lab" ? labDistance : rgbDistance;

    log("⏳ 正在运行 K-means...");

    var t0 = performance.now();
    var result = kmeans(clusterPixels, K, maxIter, distFn);
    var elapsed = (performance.now() - t0).toFixed(0);

    log("⏱ 耗时：" + elapsed + " ms，迭代 " + result.iterations + " 轮");

    // LAB 模式下，将中心点转回 RGB 用于颜色显示
    if (colorSpace === "lab") {
      result.centroids = result.centroids.map(function (c) { return labToRgb(c); });
    }

    // 保存结果
    lastResult = result;
    lastSampledCount = pixels.length;

    // console 输出
    console.log("======= K-means 聚类结果 (" + colorSpace.toUpperCase() + ") =======");
    console.log("类簇中心 (RGB)：", result.centroids);
    console.log("各类簇像素数量：", result.counts);
    console.log("迭代次数：", result.iterations);
    console.log("=================================");

    log("══════ 聚类完成 ══════");

    // 渲染
    renderTable(result, pixels.length);
    renderChart(result, pixels.length, currentChartType);

    // 显示 AI 卡片
    aiCard.style.display = "block";
  }

  // 带 debounce 的自动重跑（K 值 / 色彩空间变化时触发）
  var runClusteringDebounced = debounce(runClustering, 350);

  // ==================== 结果表格 ====================

  function renderTable(result, sampledCount) {
    var centroids = result.centroids;
    var counts = result.counts;
    var K = centroids.length;
    var maxCount = Math.max.apply(null, counts);

    var html = "";
    for (var c = 0; c < K; c++) {
      var r = Math.round(centroids[c][0]);
      var g = Math.round(centroids[c][1]);
      var b = Math.round(centroids[c][2]);
      var count = counts[c];
      var percentage = ((count / sampledCount) * 100).toFixed(1);
      var hex = rgbToHex(r, g, b);
      var barWidth = maxCount > 0 ? (count / maxCount * 100).toFixed(0) : 0;

      html +=
        '<tr>' +
          '<td><strong>类簇 ' + (c + 1) + '</strong></td>' +
          '<td><span class="color-swatch" style="background:' + hex + ';"></span></td>' +
          '<td>(' + r + ', ' + g + ', ' + b + ')</td>' +
          '<td><code>' + hex + '</code></td>' +
          '<td>' + count.toLocaleString() + '</td>' +
          '<td>' + percentage + '%</td>' +
          '<td>' +
            '<span class="cluster-bar-wrap">' +
              '<span class="cluster-bar-fill" style="width:' + barWidth + '%; background:' + hex + ';"></span>' +
            '</span>' +
          '</td>' +
        '</tr>';
    }

    resultBody.innerHTML = html;
    resultCard.style.display = "block";
    logCard.style.display = "block";
    log("📊 结果表格已渲染");
  }

  // ==================== ECharts 图表 ====================

  function buildPieData(result, sampledCount) {
    var centroids = result.centroids;
    var counts = result.counts;
    var data = [];

    for (var c = 0; c < centroids.length; c++) {
      var r = Math.round(centroids[c][0]);
      var g = Math.round(centroids[c][1]);
      var b = Math.round(centroids[c][2]);
      var hex = rgbToHex(r, g, b);
      var count = counts[c];

      data.push({
        name: "类簇 " + (c + 1),
        value: count,
        itemStyle: { color: hex },
        _rgb: "(" + r + ", " + g + ", " + b + ")",
        _hex: hex,
        _percentage: ((count / sampledCount) * 100).toFixed(1)
      });
    }
    return data;
  }

  function getPieOption(pieData) {
    return {
      legend: {
        orient: "horizontal",
        bottom: 10,
        icon: "circle",
        textStyle: { fontSize: 13 }
      },
      tooltip: {
        trigger: "item",
        formatter: function (p) {
          var d = p.data;
          return "<strong>" + d.name + "</strong><br/>" +
            "📐 像素数量：" + d.value.toLocaleString() + "<br/>" +
            "📊 占比：" + d._percentage + "%<br/>" +
            "🎨 RGB：" + d._rgb + "<br/>" +
            "🔷 Hex：" + d._hex;
        }
      },
      series: [{
        name: "颜色聚类",
        type: "pie",
        radius: ["40%", "72%"],
        center: ["50%", "48%"],
        avoidLabelOverlap: true,
        itemStyle: {
          borderRadius: 4,
          borderColor: "#fff",
          borderWidth: 1,
          shadowBlur: 10,
          shadowOffsetY: 2,
          shadowColor: "rgba(0,0,0,0.2)"
        },
        label: {
          show: true,
          formatter: function (p) { return p.data._percentage + "%"; },
          fontSize: 13,
          fontWeight: "bold"
        },
        emphasis: {
          shadowBlur: 20,
          shadowOffsetY: 8,
          shadowColor: "rgba(0,0,0,0.35)",
          scaleSize: 10
        },
        data: pieData
      }]
    };
  }

  function getBarOption(pieData) {
    return {
      legend: {
        orient: "horizontal",
        bottom: 10,
        icon: "circle",
        textStyle: { fontSize: 13 }
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: function (params) {
          var d = params[0].data;
          return "<strong>" + d.name + "</strong><br/>" +
            "📐 像素数量：" + d.value.toLocaleString() + "<br/>" +
            "📊 占比：" + d._percentage + "%<br/>" +
            "🎨 RGB：" + d._rgb + "<br/>" +
            "🔷 Hex：" + d._hex;
        }
      },
      grid: { left: 50, right: 30, top: 20, bottom: 50 },
      xAxis: {
        type: "category",
        data: pieData.map(function (d) { return d.name; }),
        axisLabel: { fontSize: 12 }
      },
      yAxis: {
        type: "value",
        name: "像素数量",
        nameTextStyle: { fontSize: 12 }
      },
      series: [{
        name: "像素数量",
        type: "bar",
        barWidth: "55%",
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          shadowBlur: 6,
          shadowOffsetY: 2,
          shadowColor: "rgba(0,0,0,0.15)"
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 14,
            shadowOffsetY: 4,
            shadowColor: "rgba(0,0,0,0.3)"
          }
        },
        data: pieData.map(function (d) {
          return {
            value: d.value,
            itemStyle: { color: d.itemStyle.color },
            _rgb: d._rgb,
            _hex: d._hex,
            _percentage: d._percentage
          };
        })
      }]
    };
  }

  function getRoseOption(pieData) {
    return {
      legend: {
        orient: "horizontal",
        bottom: 10,
        icon: "circle",
        textStyle: { fontSize: 13 }
      },
      tooltip: {
        trigger: "item",
        formatter: function (p) {
          var d = p.data;
          return "<strong>" + d.name + "</strong><br/>" +
            "📐 像素数量：" + d.value.toLocaleString() + "<br/>" +
            "📊 占比：" + d._percentage + "%<br/>" +
            "🎨 RGB：" + d._rgb + "<br/>" +
            "🔷 Hex：" + d._hex;
        }
      },
      series: [{
        name: "颜色聚类",
        type: "pie",
        radius: ["15%", "70%"],
        center: ["50%", "48%"],
        roseType: "area",
        itemStyle: {
          borderRadius: 3,
          borderColor: "#fff",
          borderWidth: 1,
          shadowBlur: 8,
          shadowOffsetY: 2,
          shadowColor: "rgba(0,0,0,0.18)"
        },
        label: {
          show: true,
          formatter: function (p) { return p.data._percentage + "%"; },
          fontSize: 12,
          fontWeight: "bold"
        },
        emphasis: {
          shadowBlur: 18,
          shadowOffsetY: 6,
          shadowColor: "rgba(0,0,0,0.3)",
          scaleSize: 8
        },
        data: pieData
      }]
    };
  }

  /**
   * 渲染/更新 ECharts 图表
   * @param {object} result       - 聚类结果
   * @param {number} sampledCount - 采样像素数
   * @param {string} chartType    - "pie" | "bar" | "rose"
   */
  function renderChart(result, sampledCount, chartType) {
    var pieData = buildPieData(result, sampledCount);

    var option;
    switch (chartType) {
      case "bar":
        option = getBarOption(pieData);
        break;
      case "rose":
        option = getRoseOption(pieData);
        break;
      default:
        option = getPieOption(pieData);
    }

    if (!chartInstance) {
      chartInstance = echarts.init(chartContainer);
    }

    // notMerge: true 确保完全替换配置（饼↔柱状结构差异大）
    chartInstance.setOption(option, { notMerge: true });

    var typeLabel = { pie: "饼图", bar: "柱状图", rose: "南丁格尔玫瑰图" }[chartType];
    log("📊 ECharts " + typeLabel + " 已渲染");
  }

  // ---- 图表类型切换 ----
  chartTypeBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      // 更新按钮选中态
      chartTypeBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");

      currentChartType = btn.dataset.type;

      // 无需重新聚类，直接切换图表类型
      if (lastResult) {
        renderChart(lastResult, lastSampledCount, currentChartType);
      }
    });
  });

  // ==================== AI 色彩和谐度分析 ====================

  aiRunBtn.addEventListener("click", function () {
    if (!lastResult) {
      alert("请先完成图片聚类！");
      return;
    }

    var endpoint = aiEndpoint.value.trim();
    var apiKey   = aiKey.value.trim();
    var model    = aiModel.value.trim();

    if (!endpoint || !apiKey) {
      alert("请填写 API 地址和 API Key！");
      return;
    }

    analyzeHarmony(lastResult.centroids, endpoint, apiKey, model);
  });

  function analyzeHarmony(centroids, endpoint, apiKey, model) {
    aiStatus.textContent = "⏳ 正在分析...";
    aiResult.textContent = "";
    aiRunBtn.disabled = true;

    // 构建颜色列表
    var colorList = centroids.map(function (c, i) {
      var r = Math.round(c[0]);
      var g = Math.round(c[1]);
      var b = Math.round(c[2]);
      var hex = rgbToHex(r, g, b);
      return (i + 1) + ". " + hex + " RGB(" + r + "," + g + "," + b + ")";
    }).join("\n");

    var prompt = "以下是 K-means 聚类从一张图片中提取的 " + centroids.length + " 种主色调：\n" +
      colorList + "\n\n" +
      "请从色彩搭配的角度简洁分析这组颜色是否和谐，控制在200字以内。包括：\n" +
      "1. 色相是否互补或协调\n" +
      "2. 饱和度和明度是否平衡\n" +
      "3. 是否符合常见的配色法则\n" +
      "4. 给出整体和谐度评分（1-10分）和一句话建议";

    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 800
      })
    })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + ": " + res.statusText);
      return res.json();
    })
    .then(function (data) {
      if (data.choices && data.choices[0]) {
        aiResult.textContent = data.choices[0].message.content;
        aiStatus.textContent = "✅ 分析完成";
        log("🤖 AI 色彩和谐度分析完成");
      } else {
        throw new Error("返回数据格式异常：" + JSON.stringify(data));
      }
    })
    .catch(function (err) {
      aiResult.textContent = "❌ 请求失败：" + err.message;
      aiStatus.textContent = "⚠️ 分析失败";
      log("❌ AI 分析失败：" + err.message);
    })
    .finally(function () {
      aiRunBtn.disabled = false;
    });
  }

  // ==================== 参数联动 ====================

  // K 值滑块 ↔ 数字框双向绑定
  kSlider.addEventListener("input", function () {
    kValueInput.value = kSlider.value;
    if (imageImageData) runClusteringDebounced();
  });
  kValueInput.addEventListener("input", function () {
    kSlider.value = kValueInput.value;
    if (imageImageData) runClusteringDebounced();
  });

  // 色彩空间切换 → 自动重跑
  colorSpaceSel.addEventListener("change", function () {
    if (imageImageData) runClustering();
  });

  // 最大迭代次数 → 自动重跑（debounce）
  maxIterInput.addEventListener("input", function () {
    if (imageImageData) runClusteringDebounced();
  });

  // 手动执行按钮（保留，用于 debounce 未触发时强制重跑）
  runBtn.addEventListener("click", function () {
    if (!imageImageData) {
      alert("请先选择一张图片！");
      return;
    }
    runClustering();
  });

  // ==================== 窗口 resize ====================
  window.addEventListener("resize", function () {
    if (chartInstance) chartInstance.resize();
  });

})();
