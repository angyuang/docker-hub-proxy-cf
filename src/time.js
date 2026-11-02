/** 北京时间（UTC+8）工具 —— 与原项目 get_shanghai_time() 语义一致 */

/** 北京时间日期串：YYYY-MM-DD */
export function shanghaiDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 北京时间日期时间串：YYYY-MM-DD HH:MM:SS */
export function shanghaiDateTime(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
