declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** Vite ?raw 导入：以字符串形式获取文件内容 */
declare module "*?raw" {
  const content: string;
  export default content;
}
