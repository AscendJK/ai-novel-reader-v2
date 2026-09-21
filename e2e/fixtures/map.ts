/**
 * 假厂商吐出来的"小说地图"数据形状（C 组与 G 组共用一份）。
 *
 * 为什么放在 fixtures 而不是各 spec 里：C4~C6 判的是图的**正确性**（连线数、NaN、
 * 幻觉降级），G4 判的是同一张图在 390px 下的**版面**。两份用例要的是同一份输入，
 * 抄一遍就会一边改了另一边还绿。
 */

export const mapPlace = (id: string, name: string, level: number, parentId: string, x: number, y: number) => ({
  id, name, level, parentId, x, y, type: "城池", description: `${name}的说明`, importance: 5, affiliation: "",
});

/**
 * 一个顶级 + 一个二级 + 两个三级。
 *
 * 顶级地点在图上不画圆点（`NovelMapSection.tsx:76` 与 `renderMap` 一致），所以"父级是
 * 顶级地点"的那条连线也不画——数连线时必须按这个口径来，否则判据会对不上：
 * 这份数据画出来的父子虚线是 洛阳→东郡 与 虎牢→东郡 两条。
 */
export const MAP_PLACES = [
  mapPlace("p1", "中州", 1, "", 500, 500),
  mapPlace("p2", "东郡", 2, "p1", 700, 400),
  // 洛阳的 x 故意写成数字字符串：模型常这么输出，`toCoord` 要归一成数字（map-agent.ts:16），
  // 归一不了就整图判失败——这条形状让 C4 对"坐标必须有限数"那道守卫真的有判别力
  mapPlace("p3", "洛阳", 3, "p2", "760" as unknown as number, 460),
  mapPlace("p4", "虎牢", 3, "p2", 780, 560),
];

export const mapFixture = (places: ReturnType<typeof mapPlace>[]) => ({
  layers: [
    { level: 1, name: "天下", description: "" },
    { level: 2, name: "郡", description: "" },
    { level: 3, name: "城", description: "" },
  ],
  places,
  regions: [],
  forces: [],
});
