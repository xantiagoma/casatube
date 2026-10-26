/**
 * `import "./styles.css"` is a side effect, not a value.
 *
 * The bundler turns it into a stylesheet link; TypeScript needs telling that
 * the module exists at all, or the entrypoint does not compile.
 */
declare module "*.css";

/** An image import is its URL: the bundler emits the file under /assets. */
declare module "*.png" {
  const url: string;
  export default url;
}
