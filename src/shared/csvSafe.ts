/** CSV 防公式注入：以 = + - @ 制表符 回车 开头的文字，Excel 会当公式执行（抖音标题常以 @ 开头）。
 *  前面加单引号让 Excel 当普通文字；纯数字（如 -12、3.5）不动。 */
export function neutralizeCsvFormula(v: string): string {
  if (!/^[=+\-@\t\r]/.test(v)) return v
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return v
  return `'${v}`
}
