const path = require("path");
const fs = require("fs");
const CopyWebpackPlugin = require("copy-webpack-plugin");

const IGNORED = new Set(["i18n"]);

const entries = fs
  .readdirSync(path.join(__dirname, "src"))
  .filter((dir) => fs.statSync(path.join("src", dir)).isDirectory())
  .filter((dir) => !IGNORED.has(dir))
  .reduce((acc, dir) => ({ ...acc, [dir]: `./src/${dir}/${dir}` }), {});

module.exports = {
  entry: entries,
  devtool: "inline-source-map",
  output: {
    filename: "[name]/[name].js",
    path: path.resolve(__dirname, 'dist')
  },
  mode: 'development',
  devServer: {
    https: true,
    port: 3000,
    open: true,
    static:{
      directory: path.resolve(__dirname, 'dist'),
      publicPath: '/dist',
    },
    hot: true,
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [{ from: "**/*.html", context: "src" }],
    }),
  ],
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/i,
        loader: "ts-loader",
        exclude: ["/node_modules/"],
      },
      {
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.s[ac]ss$/i,
        use: [
          "style-loader", 
          "css-loader", 
          {
            loader: 'sass-loader',
            options: {
              sassOptions: {
                api: 'modern-compiler'
              }
            }
          }
        ],
      },
      {
        test: /\.(eot|svg|ttf|woff|woff2|png|jpg|gif)$/i,
        type: "asset",
        dependency: { not: ['url'] },
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".jsx", ".js"],
  },
};
