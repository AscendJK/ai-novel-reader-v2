import { describe, it, expect } from "vitest";
import { prepareTextForTTS, buildOrderedParaIndices, findChunkIndexByPara } from "../text-preprocess";

describe("prepareTextForTTS", () => {
  it("空内容返回空数组", () => {
    expect(prepareTextForTTS("")).toEqual([]);
    expect(prepareTextForTTS("   ")).toEqual([]);
    expect(prepareTextForTTS(null as unknown as string)).toEqual([]);
  });

  it("单段落不合并", () => {
    const result = prepareTextForTTS("这是一段测试文本，用来验证段落处理逻辑。");
    expect(result.length).toBe(1);
    expect(result[0].paragraphIndices).toEqual([0]);
    expect(result[0].paragraphBreaks).toEqual([0]);
  });

  it("过短段落被过滤（< 5 字）", () => {
    const result = prepareTextForTTS("短。\n这是一个正常的段落内容。");
    expect(result.length).toBe(1);
    expect(result[0].paragraphIndices).toEqual([1]);
  });

  it("相邻短段落被合并", () => {
    const result = prepareTextForTTS(
      "第一段内容大约有三十个字符左右。\n第二段内容也大约有三十个字符左右。"
    );
    expect(result.length).toBe(1);
    expect(result[0].paragraphIndices).toEqual([0, 1]);
    expect(result[0].paragraphBreaks.length).toBe(2);
  });

  it("足够长的段落不合并（合计 > 150 字）", () => {
    // 每段需要清理后超过 80 字，合计才 > 150
    const longP1 = "这是第一段非常非常长的内容用来测试段落合并的阈值判断逻辑是否正确。这段文字必须足够长才能确保两个段落合计超过一百五十个字符的合并限制阈值标准。我们来仔细数一数字数是不是真的够长了。";
    const longP2 = "这是第二段非常非常长的内容也用来测试段落合并的阈值判断逻辑是否正确。这段文字也必须足够长才能确保两个段落合计超过一百五十个字符的合并限制阈值标准。我们来仔细数一数字数。";
    const result = prepareTextForTTS(`${longP1}\n${longP2}`);
    expect(result.length).toBe(2);
    expect(result[0].paragraphIndices).toEqual([0]);
    expect(result[1].paragraphIndices).toEqual([1]);
  });

  it("超长单段落按句子拆分", () => {
    const longText = "这是用来测试超长段落拆分的句子内容。".repeat(20);
    const result = prepareTextForTTS(longText);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(350);
    }
  });

  it("句子完整性：不会把一句话拆开朗读（小 chunk 上限）", () => {
    // 每句约 22 字，chunk 上限 30 → 相邻句子聚合到 ≤30 字，单句不拆
    const text = "他推开门走进来，屋里的灯光很暗。夜已经很深了，窗外的雨还在下个不停。月光洒在地板上，像一层薄薄的银纱。";
    const result = prepareTextForTTS(text, 30);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      // 每个 chunk 都以句号结尾（整句结束），不包含半句
      expect(chunk.text.trim().endsWith("。")).toBe(true);
    }
    // 拼接后与原文一致（无内容丢失/无硬切）
    expect(result.map(c => c.text).join("")).toBe(text);
  });

  it("句子完整性：单句超过上限时整句保留，不硬切", () => {
    // 一句 50 字 > 上限 30：整句作为一个 chunk（宁超不拆）
    const longSentence = "这是一个非常长的句子用来验证单个句子超过字数上限时不会被硬切开的处理逻辑是否正确运行。";
    const result = prepareTextForTTS(longSentence, 30);
    expect(result.length).toBe(1);
    expect(result[0].text).toBe(longSentence);
  });

  it("句子完整性：无句号的长段落按逗号切分，逗号片段不拆", () => {
    // 无句号段落（逗号分隔），chunk 上限 25 → 逗号片段聚合，不拆半句
    const text = "他站在那里，静静地看着熟睡中的女儿，心里涌起一阵说不清的温柔与愧疚，眼泪悄悄滑落";
    const result = prepareTextForTTS(text, 25);
    expect(result.length).toBeGreaterThan(1);
    // 聚合后的片段要么 ≤25 字，要么是单片段超过上限（整段保留）
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(30);
    }
    expect(result.map(c => c.text).join("")).toBe(text);
  });

  it("段落索引与正文渲染一致：跨行 HTML 标签不合并段落", () => {
    // 正文渲染用 content.split(/\n+/) 的下标；prepareTextForTTS 必须给出相同下标。
    // 跨行标签（<p\nclass=...>）若在 split 前全局剥除会把两行合并成一段，
    // 导致索引错位、朗读高亮指向错误段落。逐段剥标签后段落数应与 split 一致。
    const content = "<p class=\"a\">第一段内容，测试跨行标签。\n第二段内容，也应该保留。\n<img src=\"x\">";
    const result = prepareTextForTTS(content, 300);
    const rawParas = content.split(/\n+/);
    // 被过滤的段落（空/过短）不在 chunk 中，但保留的段落索引必须与 split 下标一致
    const keptIndices = result.flatMap(c => c.paragraphIndices);
    for (const idx of keptIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(rawParas.length);
    }
    // 有文本内容的段落（≥5 字）都应被保留且索引正确：
    // 第一段（去标签后）与第二段必须分别存在，且索引为 0 和 1
    const texts = result.map(c => c.text);
    expect(texts.some(t => t.includes("第一段内容"))).toBe(true);
    expect(texts.some(t => t.includes("第二段内容"))).toBe(true);
    // 第三行 <img> 被剥成空 → 过滤，不产生索引 2
    expect(keptIndices.every(i => i < 2)).toBe(true);
  });

  it("合并段落的 paragraphBreaks 记录分割点", () => {
    // 使用足够长的段落以确保合并后 breaks 有多个值
    const p1 = "这是第一段内容用来测试段落合并后的分割点记录功能。";
    const p2 = "这是第二段内容用来测试段落合并后的分割点记录功能。";
    const result = prepareTextForTTS(`${p1}\n${p2}`);
    // 两段合并（合计 < 150）
    expect(result.length).toBe(1);
    const chunk = result[0];
    // paragraphBreaks 应该有两个值：[0, 第二段起始位置]
    expect(chunk.paragraphBreaks.length).toBe(2);
    expect(chunk.paragraphBreaks[0]).toBe(0);
    expect(chunk.paragraphBreaks[1]).toBeGreaterThan(0);
    expect(chunk.paragraphBreaks[1]).toBeLessThan(chunk.text.length);
  });

  it("HTML 标签被清除", () => {
    const result = prepareTextForTTS("<p>这是段落内容</p>\n<b>加粗文字</b>");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].text).not.toContain("<p>");
    expect(result[0].text).not.toContain("</p>");
  });

  it("段落级模式（server 高亮）：每段独立成 chunk，不合并短段", () => {
    // 三段短段落：默认模式会合并（合计 < 150），段落级模式每段独立
    const text = "第一段内容。\n第二段内容。\n第三段内容。";
    const merged = prepareTextForTTS(text, 150);
    expect(merged.length).toBe(1); // 默认合并成 1 个 chunk
    expect(merged[0].paragraphIndices).toEqual([0, 1, 2]);

    const single = prepareTextForTTS(text, 150, true);
    expect(single.length).toBe(3); // 段落级：3 个独立 chunk
    expect(single[0].paragraphIndices).toEqual([0]);
    expect(single[1].paragraphIndices).toEqual([1]);
    expect(single[2].paragraphIndices).toEqual([2]);
    // 每个 chunk 的 breaks 只有 [0]（单段，起点即文本开头）
    expect(single.every(c => c.paragraphBreaks.length === 1 && c.paragraphBreaks[0] === 0)).toBe(true);
  });

  it("段落级模式：超长段落仍按句拆分，短段不合并", () => {
    const text = "短段落一。\n短段落二。\n这是第三段非常长的内容用来测试段落级模式下超长段落仍然会被正确拆分的逻辑是否正确运行。";
    const single = prepareTextForTTS(text, 30, true);
    // 前两段独立成 chunk；第三段超长按句子拆分
    expect(single[0].paragraphIndices).toEqual([0]);
    expect(single[1].paragraphIndices).toEqual([1]);
    for (const chunk of single) {
      expect(chunk.text.length).toBeLessThanOrEqual(350);
    }
  });

  it("引号替换为逗号", () => {
    const result = prepareTextForTTS('"你好"说他，"再见"说她。');
    expect(result.length).toBe(1);
    expect(result[0].text).not.toContain('"');
    expect(result[0].text).not.toContain('"');
  });

  it("过滤整段方括号包裹的装饰内容（朗读杂音来源）", () => {
    const result = prepareTextForTTS("[大家新年好]\n这是正文内容，长度足够参与朗读。");
    expect(result.length).toBe(1);
    expect(result[0].text).not.toContain("新年好");
    expect(result[0].paragraphIndices).toEqual([1]);
  });

  it("过滤常见网站残留标记（[本章完]等）", () => {
    const result = prepareTextForTTS("这是正文第一段，内容长度足够。\n[本章完]\n这是正文第二段，内容长度足够。");
    expect(result.length).toBeGreaterThan(0);
    const allText = result.map(c => c.text).join("");
    expect(allText).not.toContain("本章完");
    expect(allText).not.toContain("[");
    expect(allText).toContain("第一段");
    expect(allText).toContain("第二段");
  });

  it("删除行内方括号字符（避免 OOV 与“左括号”读音）", () => {
    const result = prepareTextForTTS("他收到[系统]提示，然后继续前行。");
    expect(result.length).toBe(1);
    expect(result[0].text).not.toContain("[");
    expect(result[0].text).not.toContain("]");
    expect(result[0].text).toContain("系统");
  });

  it("多个 chunk 的 paragraphIndices 递增", () => {
    const p1 = "第一段内容大约有一百个字符左右，用来测试长段落的处理逻辑是否正确运行。这是一段比较长的内容。";
    const p2 = "第二段内容大约有一百个字符左右，用来验证分段功能的正确性运行。这是另一段比较长的内容。";
    const p3 = "第三段内容大约有一百个字符左右，确保多段落处理没有问题运行。这是第三段比较长的内容。";
    const result = prepareTextForTTS(`${p1}\n${p2}\n${p3}`);
    for (const chunk of result) {
      expect(chunk.paragraphIndices.length).toBeGreaterThan(0);
      for (let j = 1; j < chunk.paragraphIndices.length; j++) {
        expect(chunk.paragraphIndices[j]).toBeGreaterThan(chunk.paragraphIndices[j - 1]);
      }
    }
  });

  describe("buildOrderedParaIndices（进度坐标映射）", () => {
    it("过滤短段落后，展开索引就是保留段落的原始索引", () => {
      // 原文 4 段，第 0 段（“嗯。”）和第 3 段（“好。”）< 5 字被过滤
      const content = "嗯。\n这是第一段正常内容，长度足够参与朗读。\n这是第二段正常内容，长度也足够参与朗读。\n好。";
      const chunks = prepareTextForTTS(content);
      const ordered = buildOrderedParaIndices(chunks);
      expect(ordered).toEqual([1, 2]);
      // 过滤后总数 = 展开数组长度，与原文段落数解耦（修复前会用 4 做分母）
      expect(ordered.length).toBe(2);
    });

    it("进度坐标不溢出：过滤后序号始终 < 总数", () => {
      const content = Array.from({ length: 30 }, (_, i) =>
        i % 5 === 0 ? `短${i}` : `第 ${i} 段内容，长度足够，用来验证进度坐标的一致性。`
      ).join("\n");
      const chunks = prepareTextForTTS(content);
      const ordered = buildOrderedParaIndices(chunks);
      // 过滤后总数
      const total = ordered.length;
      // 任意保留段落的过滤后序号 + 1 不超过总数（进度条不会 >100%）
      for (let idx = 0; idx < ordered.length; idx++) {
        const rawIdx = ordered[idx];
        const filteredIdx = ordered.indexOf(rawIdx);
        expect(filteredIdx).toBe(idx); // 有序且一一对应
        expect(filteredIdx + 1).toBeLessThanOrEqual(total);
      }
      expect(total).toBeLessThan(30); // 确认确实发生了过滤（有短段被剔除）
    });

    it("seek 映射：点击进度条位置能映射回正确的原始段落索引", () => {
      const content = Array.from({ length: 20 }, (_, i) =>
        i % 4 === 0 ? `短${i}` : `第 ${i} 段内容，长度足够用来验证 seek 映射的准确性。`
      ).join("\n");
      const chunks = prepareTextForTTS(content);
      const ordered = buildOrderedParaIndices(chunks);
      const total = ordered.length;
      // 模拟点击进度条中部（50% 位置）
      const targetFilteredIdx = Math.min(total - 1, Math.round(0.5 * (total - 1)));
      const targetPara = ordered[targetFilteredIdx];
      // 映射回的原始索引必须存在于 ordered 中（能正确恢复位置/高亮）
      expect(ordered.includes(targetPara)).toBe(true);
      expect(ordered.indexOf(targetPara)).toBe(targetFilteredIdx);
      // 且原始索引一定是一个真实段落的索引（>=0）
      expect(targetPara).toBeGreaterThanOrEqual(0);
    });
  });

  describe("findChunkIndexByPara（chunk 精确定位）", () => {
    // 直接构造 chunk 分组（不依赖 prepareTextForTTS 的合并行为，聚焦定位逻辑）：
    //   chunk0: [0,1]（合并组）
    //   chunk1: [2]（独立段）
    //   chunk2: [3,4]（合并组）
    const chunks = [
      { text: "第一段。第二段。", paragraphIndex: 0, paragraphIndices: [0, 1], paragraphBreaks: [0, 5] },
      { text: "第三段。", paragraphIndex: 2, paragraphIndices: [2], paragraphBreaks: [0] },
      { text: "第四段。第五段。", paragraphIndex: 3, paragraphIndices: [3, 4], paragraphBreaks: [0, 5] },
    ];

    it("定位到组内第一段", () => {
      expect(findChunkIndexByPara(chunks, 0)).toBe(0);
    });

    it("定位到组内中间段（修复跳组丢句）", () => {
      // 段落 1 在 [0,1] 组内：旧逻辑（只用组首比较）会跳到下一组，新逻辑应落在本组
      expect(findChunkIndexByPara(chunks, 1)).toBe(0);
    });

    it("定位到独立段落所在组", () => {
      expect(findChunkIndexByPara(chunks, 2)).toBe(1);
    });

    it("定位到组内末段", () => {
      expect(findChunkIndexByPara(chunks, 4)).toBe(2);
    });

    it("段落不存在（超出范围）时回退到最后一个 chunk", () => {
      expect(findChunkIndexByPara(chunks, 99)).toBe(2);
    });

    it("空 chunks 返回 -1", () => {
      expect(findChunkIndexByPara([], 0)).toBe(-1);
    });
  });
});
