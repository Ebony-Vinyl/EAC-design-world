# 内置调色工作流（color-workflow）

`src/color-workflow.mjs` 是插件内置的**本地、确定性**调色辅助层，给 AI 提供三件事：严格校验外部 `.cube` LUT、非破坏性保存/恢复调色版本、按实测亮度给出**有界曝光**的镜头匹配建议。它不调用达芬奇/Premiere、不访问任何外部服务、不做"AI 打分"，也不保存用户凭证。对外工具是 `color_workflow`（HTTP: `POST /api/projects/:id/color`）。

## 边界（先读这段）

- **只处理曝光**：`suggestShotMatch` 只输出曝光增量建议，不判断白平衡、色彩风格、构图或叙事，也不代表"完美镜头匹配"。
- **只按实测亮度**：依据 `gradePreview` 返回的**调色后**（`frames[].graded`）统计；不做 original 回退，因为未调色的统计无法证明当前观感。
- **有界且粗粒度**：增量取到 `0.05` 网格（朝修正方向向上取，避免小于实测差距），默认上限 ±0.5，超出即转人工复核；`|建议| < 0.05` 视为已匹配。
- **粗估不是精确档位**：亮度均值到曝光是近似换算（`log2` 比例），不代表精确 stops；结论必须用 `grade-preview` 复核。
- **不自动套用**：save/restore 只返回新项目对象，由调用方决定是否写库；match-shots 只返回建议 JSON。
- **不做色彩管理**：不转换色域/传递函数（log/HLG/HDR），`.cube` 只做 3D LUT 结构校验，不验证其色彩语义。

## 1. LUT 校验：`validateCubeFile(path)` / `parseCubeLut(text)`

`validateCubeFile` 是唯一异步函数，返回 `{ path, size, bytes, title, domainMin, domainMax, entryCount }`，其中 `path` 是 `realpath` 得到的规范绝对路径（engine 存盘用这个字段）。校验规则：

| 规则 | 说明 |
| --- | --- |
| 扩展名 | 必须是 `.cube`（大小写不敏感），否则 `TypeError` |
| 存在性 | 路径不存在 → `LUT 文件不存在`；目录/非普通文件 → 报错 |
| 大小上限 | `MAX_CUBE_BYTES` = 16 MiB |
| 类型 | **仅 3D LUT**：`LUT_1D_SIZE`、`LUT_1D_INPUT_RANGE` 直接拒绝 |
| `LUT_3D_SIZE` | 必需、只能出现一次、整数 `2..65` |
| `TITLE` | 可选、最多一次、不能为空 |
| `DOMAIN_MIN/MAX` | 可选，各 3 个有限数字，默认 0/1；每通道必须 `MIN < MAX` |
| 数据行 | 必须**恰好** `size³` 行，每行 3 个有限数字（`NaN`/`Infinity`/溢出如 `1e999` 拒绝，且必须能表示为 32 位浮点），红索引最快 |
| 其他 | 允许 `#` 注释与空行；未知关键字、重复关键字、数据区之后出现关键字都拒绝 |

`parseCubeLut(text)` 是同步纯函数，返回 `{ size, title, domainMin, domainMax, entryCount, data }`，`data` 为 `Float32Array`（`size³ × 3`，红索引最快），便于宿主自行取样。

## 2. 非破坏性调色版本

### `saveGradeVersion(project, { name, description? })`

返回**新的** project 对象（入参不被修改、`revision` 不变，写库与 `revision++` 由 `store.updateProject` 完成）。在 `project.gradeVersions`（缺省视为 `[]`）追加：

```js
{
  id, name, description, createdAt,
  look,                                  // 项目级 look（无则 null）
  clipIds,                               // 保存时的片段 id 顺序
  clips: [{ clipId, grading, inputLut, lut, windows }]  // 缺失字段记为 null
}
```

限制：`name` 去空白后 1..80 字，`description` ≤280 字；每个片段必须有唯一 `id`；最多 50 个版本（`MAX_VERSIONS`），超出报错要求先清理。

### `restoreGradeVersion(project, versionId | { versionId })`

返回**新的** project 对象。只替换 `project.look` 与每个片段的 `grading`/`inputLut`/`lut`/`windows`，**剪辑点（`start`/`duration`/`sourceIn`）、字幕和其他字段一律保留**；版本里记为 `null` 的调色字段会从片段上删除。片段按 `id` 匹配（顺序可变）。

失败即**完全不改**：

- 版本 id 不存在 → `调色版本不存在`；
- 当前片段 id 集合与版本不一致（新增/删除了片段）→ 报错，提示撤销剪辑改动或另存新版本。

`gradeVersions` 与 `revision` 本身不被 restore 改动。

### `gradeSignature(project)`

`sha256`（hex），只覆盖**调色状态**：`look` + 每片段 `{ id, grading, inputLut, lut, windows }`，对象键序无关，剪辑/字幕/元数据变化不影响。用于把预览与当时的调色状态绑定；宿主若需"剪辑变化也让预览过期"，应使用自己的、更严格的编辑指纹（engine 目前就是这样做的）。

## 3. 镜头匹配：`suggestShotMatch(preview, { referenceClipId | referenceClipIndex, maxExposure = 0.5 })`

输入是 `gradePreview` 的返回值（`{ frames: [...] }`），每帧需带 `graded.lumaAvg`（0..255）、`graded.highlightClip`/`graded.shadowCrush`（0..1，缺省视为 0，非法值直接报错）与 `clipIndex`（有 `clipId` 时优先按 id 分组）。同一片段的多帧取**最差**的裁切/死黑值，避免一帧干净就掩盖另一帧的问题。返回值：

```js
{
  referenceClipId,
  reference: { clipId, clipIndex, lumaAvg, sampleCount },
  recommendations: [{
    clipId, clipIndex, measuredLuma, referenceLuma, sampleCount,
    exposureDelta,        // 相对当前调色的增量，建议直接加到 clip/look 的 exposure 上
    exposure,             // deprecated：与 exposureDelta 同值，切勿当作绝对曝光
    reason                // 含「相对当前调色」与复核提示
  }],
  needsReview: [{ clipId, clipIndex, measuredLuma, referenceLuma, sampleCount, reason, neededExposure? }],
  method: 'measured-graded-luma', bounded: true, maxExposure,
  disclaimer
}
```

判定顺序（每个非参考片段）：

1. 样本不可靠 → `needsReview`：多帧亮度跨度 >25（不稳定）、高光裁切 ≥2%、暗部死黑 ≥2%、亮度均值 <20（近黑）或 >235（近白）。
2. 需要增量 `log2(参考亮度 / 该片段亮度)`；绝对值 <0.05 → 视为已匹配，不输出。
3. 向上取整到 0.05；若超过 `maxExposure` → `needsReview`（附 `neededExposure`），否则进 `recommendations`。

参考片段本身必须可靠，否则抛 `参考片段不能作为可靠基准：…`。`preview` 缺失/空/无 `graded` → `缺少可用的调色预览帧…` 或 `TypeError`；`maxExposure` 必须在 `0.1..2`。

## 4. 推荐用法

```js
// 保存 → 改剪辑 → 只恢复调色
let next = saveGradeVersion(project, { name: '青橙 v2' });     // 交给 store.updateProject
// …timeline_update 改 cut…
next = restoreGradeVersion(project, versionId);                // 剪辑保留，仅调色回滚

// 生成预览后匹配
const preview = await gradePreview({ project, outputPath });
const advice = suggestShotMatch(preview, { referenceClipId: project.clips[0].id, maxExposure: 0.5 });
// advice.recommendations 的 exposureDelta 是相对当前调色的增量；needsReview 必须人工/视觉复核
```

配套文档：`docs/grading.md`（参数、预设与迭代协议）。测试：`tests/color-workflow.test.mjs`（真实临时文件，覆盖 canonical 路径、严格解析边界、版本非破坏性、过期/不可靠样本拒绝）。
