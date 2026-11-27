// Metro resolves an .html require to an asset module ID (metro.config.js).
declare module "*.html" {
  const asset: number;
  export default asset;
}
