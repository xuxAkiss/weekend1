/**
 * kmeans.js — 核心算法模块
 * 包含：色彩空间转换（RGB ↔ LAB）、距离函数、像素提取、K-means 聚类
 * 无外部依赖，纯原生 JavaScript
 */
(function (global) {
  "use strict";

  // ==================== 色彩空间转换：RGB ↔ LAB ====================

  // D65 标准光源参考白点
  var D65_X = 0.95047;
  var D65_Y = 1.00000;
  var D65_Z = 1.08883;

  /**
   * sRGB 单通道线性化（去 Gamma）
   */
  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /**
   * 线性值转回 sRGB（加 Gamma）
   */
  function linearToSrgb(c) {
    c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, c)) * 255);
  }

  /**
   * RGB → XYZ (D65)
   * @param {number[]} rgb - [R, G, B], 0-255
   * @returns {number[]} [X, Y, Z]
   */
  function rgbToXyz(rgb) {
    var r = srgbToLinear(rgb[0]);
    var g = srgbToLinear(rgb[1]);
    var b = srgbToLinear(rgb[2]);

    return [
      (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 100,
      (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) * 100,
      (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) * 100
    ];
  }

  /**
   * XYZ → RGB (D65)
   * @param {number[]} xyz - [X, Y, Z]
   * @returns {number[]} [R, G, B], 0-255
   */
  function xyzToRgb(xyz) {
    var x = xyz[0] / 100;
    var y = xyz[1] / 100;
    var z = xyz[2] / 100;

    var r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
    var g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
    var b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

    return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
  }

  /**
   * LAB 转换辅助函数
   */
  function labF(t) {
    var delta = 6 / 29;
    var delta3 = delta * delta * delta; // (6/29)^3
    return t > delta3 ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
  }

  function labFInv(t) {
    var delta = 6 / 29;
    var delta3 = delta * delta * delta;
    return t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29);
  }

  /**
   * RGB → LAB
   * 路径：sRGB linearize → XYZ → LAB
   *
   * @param {number[]} rgb - [R, G, B], 0-255
   * @returns {number[]} [L, a, b]
   *   L: 亮度 (0=黑, 100=白)
   *   a: 绿-红 (-128 ~ +128)
   *   b: 蓝-黄 (-128 ~ +128)
   */
  function rgbToLab(rgb) {
    var xyz = rgbToXyz(rgb);
    var fx = labF(xyz[0] / (D65_X * 100));
    var fy = labF(xyz[1] / (D65_Y * 100));
    var fz = labF(xyz[2] / (D65_Z * 100));

    return [
      116 * fy - 16,           // L
      500 * (fx - fy),         // a
      200 * (fy - fz)          // b
    ];
  }

  /**
   * LAB → RGB
   * 路径：LAB → XYZ → linear RGB → sRGB
   *
   * @param {number[]} lab - [L, a, b]
   * @returns {number[]} [R, G, B], 0-255
   */
  function labToRgb(lab) {
    var L = lab[0];
    var a = lab[1];
    var b = lab[2];

    var fy = (L + 16) / 116;
    var fx = a / 500 + fy;
    var fz = fy - b / 200;

    var x = labFInv(fx) * D65_X * 100;
    var y = labFInv(fy) * D65_Y * 100;
    var z = labFInv(fz) * D65_Z * 100;

    return xyzToRgb([x, y, z]);
  }

  global.rgbToLab = rgbToLab;
  global.labToRgb = labToRgb;

  // ==================== 距离函数 ====================

  /**
   * RGB 空间欧几里得距离
   * @param {number[]} a - [R, G, B]
   * @param {number[]} b - [R, G, B]
   * @returns {number}
   */
  function rgbDistance(a, b) {
    var dr = a[0] - b[0];
    var dg = a[1] - b[1];
    var db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /**
   * LAB 空间欧几里得距离（感知均匀，比 RGB 距离更符合人眼）
   * @param {number[]} a - [L, a, b]
   * @param {number[]} b - [L, a, b]
   * @returns {number}
   */
  function labDistance(a, b) {
    var dL = a[0] - b[0];
    var da = a[1] - b[1];
    var db = a[2] - b[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  global.rgbDistance = rgbDistance;
  global.labDistance = labDistance;

  // ==================== 像素提取 ====================

  /**
   * 从 ImageData 中采样提取像素数组
   *
   * 对于大图（总像素 > maxPixels），进行均匀降采样，
   * 避免浏览器卡死。采样策略为等间隔采样（stride）。
   *
   * @param {ImageData} imageData - Canvas 原始像素数据
   * @param {number}    maxPixels  - 最大处理像素数
   * @returns {{ pixels: number[][], stride: number, totalActual: number }}
   */
  function extractPixels(imageData, maxPixels) {
    var data  = imageData.data;
    var total = imageData.width * imageData.height;
    var stride = Math.max(1, Math.ceil(total / maxPixels));
    var pixels = [];

    for (var i = 0; i < total; i += stride) {
      var offset = i * 4;
      pixels.push([
        data[offset],     // R
        data[offset + 1], // G
        data[offset + 2]  // B
      ]);
    }

    return {
      pixels: pixels,
      stride: stride,
      totalActual: total
    };
  }

  global.extractPixels = extractPixels;

  // ==================== K-means 聚类算法 ====================

  /**
   * K-means 聚类算法 — 在指定色彩空间中对像素颜色进行聚类
   *
   * 算法步骤：
   *   1. 随机选择 K 个像素点作为初始中心
   *   2. 分配阶段：将每个像素归入距离最近的中心所属的类簇
   *   3. 更新阶段：重新计算每个类簇内所有像素的均值作为新中心
   *   4. 检查收敛：若所有中心变化量小于阈值，或达到最大迭代次数，则停止
   *   5. 否则回到步骤 2 继续迭代
   *
   * @param {number[][]} pixels     - 像素数组，每个元素为 [R, G, B] 或 [L, a, b]
   * @param {number}     k          - 聚类数量
   * @param {number}     maxIter    - 最大迭代次数
   * @param {Function}   [distanceFn] - 距离函数，默认 rgbDistance
   * @returns {{ centroids: number[][], counts: number[], iterations: number }}
   */
  function kmeans(pixels, k, maxIter, distanceFn) {
    var distFn = distanceFn || rgbDistance;
    var n = pixels.length;
    var dim = pixels[0].length;

    // ---- 步骤 1：随机初始化 K 个中心点 ----
    var usedIndices = {};
    var centroids = [];

    while (centroids.length < k) {
      var idx = Math.floor(Math.random() * n);
      if (!usedIndices[idx]) {
        usedIndices[idx] = true;
        centroids.push(pixels[idx].slice()); // 深拷贝
      }
    }

    // 像素→类簇标签
    var labels = new Uint16Array(n);
    var finalIter = 0;

    // ---- 步骤 2-4：迭代优化 ----
    for (var iter = 0; iter < maxIter; iter++) {
      finalIter = iter + 1;

      // 2. 分配阶段：每个像素归入最近的中心
      var changedCount = 0;
      for (var i = 0; i < n; i++) {
        var pixel = pixels[i];
        var bestCluster = 0;
        var bestDist = Infinity;

        for (var c = 0; c < k; c++) {
          var dist = distFn(pixel, centroids[c]);
          if (dist < bestDist) {
            bestDist = dist;
            bestCluster = c;
          }
        }

        if (labels[i] !== bestCluster) changedCount++;
        labels[i] = bestCluster;
      }

      // 3. 更新阶段：重新计算中心
      var sums = [];
      var counts = new Uint32Array(k);
      for (var ci = 0; ci < k; ci++) {
        sums[ci] = new Array(dim).fill(0);
      }

      for (var j = 0; j < n; j++) {
        var cl = labels[j];
        var px = pixels[j];
        for (var dc = 0; dc < dim; dc++) {
          sums[cl][dc] += px[dc];
        }
        counts[cl]++;
      }

      var maxShift = 0;
      for (var c2 = 0; c2 < k; c2++) {
        var oldCentroid = centroids[c2];
        var newCentroid;

        if (counts[c2] === 0) {
          newCentroid = oldCentroid.slice();
        } else {
          newCentroid = [];
          for (var dc2 = 0; dc2 < dim; dc2++) {
            newCentroid[dc2] = sums[c2][dc2] / counts[c2];
          }
        }

        var shift = distFn(oldCentroid, newCentroid);
        if (shift > maxShift) maxShift = shift;
        centroids[c2] = newCentroid;
      }

      // 4. 收敛判断
      if (maxShift < 0.5) {
        break;
      }
    }

    // ---- 最终统计 ----
    var finalCounts = new Uint32Array(k);
    for (var fi = 0; fi < n; fi++) {
      finalCounts[labels[fi]]++;
    }

    return {
      centroids: centroids,
      counts: Array.from(finalCounts),
      iterations: finalIter
    };
  }

  global.kmeans = kmeans;

})(window);
