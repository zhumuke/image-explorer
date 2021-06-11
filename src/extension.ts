import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { posix } from "path";
import { allowedNodeEnvironmentFlags } from "node:process";
let focusDir = "";

export function activate(context: vscode.ExtensionContext) {
  console.log('"imageExplorer" 激活');

  const dir: [] =
    vscode.workspace.getConfiguration("imageExplorer").directoryName || [];

  const cssTpl: string =
    vscode.workspace.getConfiguration("imageExplorer").template.cssUrl || "";

  const jsTpl: string =
    vscode.workspace.getConfiguration("imageExplorer").template.jsxImport || "";

  const rootDir: string =
    vscode.workspace.getConfiguration("imageExplorer").rootDirectory || "src";

  const allDirs: string[] =
    vscode.workspace.getConfiguration("imageExplorer").allPath || [];

  const workSpaceDirName = vscode.workspace.workspaceFolders
    ? vscode.workspace.workspaceFolders[0].name
    : "";

  const workSpaceUri = vscode.workspace.workspaceFolders
    ? vscode.workspace.workspaceFolders[0].uri
    : null;

  // 设置有右键菜单的目录,用于插件package.json中的when语句
  vscode.commands.executeCommand(
    "setContext",
    "ext.imageExplorer.supportedFolders",
    allDirs.map((item) => {
      const ps = item.split("/");
      return ps[ps.length - 1];
    })
  );

  let disposableImg = vscode.commands.registerCommand(
    "imageExplorer.showImageExplorer",
    async (url) => {
      if (!workSpaceUri) {
        vscode.window.showInformationMessage("no workspace, choose one!");
        return;
      }
      let files = {};

      if (allDirs) {
        for (let index = 0; index < allDirs.length; index++) {
          const dir = allDirs[index];
          // const t = vscode.Uri.joinPath(workSpaceUri, dir);
          const ds = await getImgOfDir(vscode.Uri.parse(dir));
          if (ds.length > 0) {
            files = { ...files, [dir]: ds };
          }
        }
      }

      // 右键点击某个图片目录，点击菜单命令方式进入
      if (url) {
        const dirName = url.path.split(workSpaceDirName)[1];
        focusDir = dirName;
        // 如果没有则加入到所有图片路径中
        if (allDirs && allDirs.indexOf(dirName) === -1) {
          const ds = await getImgOfDir(url);
          files = { ...files, [dirName]: ds };
          vscode.workspace
            .getConfiguration()
            .update("imageExplorer.allPath", [dirName, ...allDirs]);
        }
      }

      // 创建webview
      const panel = vscode.window.createWebviewPanel(
        "feResourceWebView", // viewType
        "静态资源视图", // 视图标题
        vscode.ViewColumn.One, // 显示在编辑器的哪个部位
        {
          enableScripts: true, // 启用JS，默认禁用
          retainContextWhenHidden: true, // webview被隐藏时保持状态，避免被重置
        }
      );

      const imgText: string = getImageElementHTML(
        files,
        workSpaceDirName,
        cssTpl,
        jsTpl
      );

      const webviewHtml = handleWebViewContent(context, "./index.html");
      panel.webview.html = webviewHtml
        .replace("${images}", imgText)
        .replace("${total}", getTotalNumberOfImages(files));

      // 响应webview的刷新图片的命令
      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.command === "scanProjectImages") {
            const allDirs: string[] =
              vscode.workspace
                .getConfiguration()
                .get("imageExplorer.allPath") || [];
            let dirsImagesMap = {};
            let newImagePath: string[] = []; // 过滤掉不包含图片的目录，更新配置属性
            // 配置中的路径
            if (allDirs) {
              for (let index = 0; index < allDirs.length; index++) {
                const dir = allDirs[index];
                // const t = vscode.Uri.joinPath(workSpaceUri, dir);
                const ds = await getImgOfDir(vscode.Uri.parse(dir));
                if (ds.length > 0) {
                  newImagePath.push(dir);
                  dirsImagesMap = { ...dirsImagesMap, [dir]: ds };
                }
              }
            }

            const rootDirUri = vscode.Uri.joinPath(workSpaceUri, rootDir);
            // 合新一次扫描的结果
            const scanResult = await scanImgDirs(rootDirUri, dir);
            const scanPath = Object.keys(scanResult);
            scanPath.forEach((path) => {
              if (newImagePath.indexOf(path) === -1) {
                newImagePath.push(path);
              }
            });
            // 合并后的结果更新到配置中
            vscode.workspace
              .getConfiguration()
              .update("imageExplorer.allPath", newImagePath);

            // 更新有右键菜单的目录
            vscode.commands.executeCommand(
              "setContext",
              "ext.imageExplorer.supportedFolders",
              newImagePath.map((item) => {
                const ps = item.split("/");
                return ps[ps.length - 1];
              })
            );

            dirsImagesMap = { ...dirsImagesMap, ...scanResult };
            const imgElementStr = getImageElementHTML(
              dirsImagesMap,
              workSpaceDirName,
              cssTpl,
              jsTpl
            );
            panel.webview.html = webviewHtml
              .replace("${images}", imgElementStr)
              .replace("${total}", getTotalNumberOfImages(dirsImagesMap));
            // panel.webview.postMessage({ command: 'scan finished' });
          }
        },
        undefined,
        context.subscriptions
      );
    }
  );

  context.subscriptions.push(disposableImg);
}

// this method is called when your extension is deactivated
export function deactivate() {}

//返回所有的图片文件路径
async function getImgOfDir(folder: vscode.Uri): Promise<string[]> {
  const files = [];
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(
      folder
    )) {
      if (type === vscode.FileType.File) {
        const filePath = posix.join(folder.path, name);
        files.push(
          vscode.Uri.parse(filePath)
            .with({ scheme: "vscode-resource" })
            .toString()
        );
      }
    }
  } catch (error) {
    // 目录不存在
    return [];
  }
  return files;
}

// 扫描一个目录下的图片
async function scanImgDirs(rootDir: vscode.Uri, imgDirs = ["images"]) {
  const dirs = [rootDir];
  let result = {};

  while (dirs.length > 0) {
    const dir = dirs.pop();
    const files = [];
    if (dir) {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
        const subPath = vscode.Uri.parse(posix.join(dir.path, name));
        if (type === vscode.FileType.File) {
          const isImg = [".jpg", ".png", ".jpeg"].some((d) => name.endsWith(d));
          if (isImg) {
            files.push(subPath.with({ scheme: "vscode-resource" }).toString());
          }
        } else if (type === vscode.FileType.Directory) {
          const isImgDir = imgDirs.indexOf(name) > -1;
          dirs.push(subPath);
        }
      }
      if (files.length > 0) {
        result = { ...result, [dir.path]: files };
      }
    }
  }
  return result;
}

function getImageElementHTML(
  files: { [key: string]: string[] },
  workSpaceDirName: string,
  cssTpl: string,
  jsTpl: string
) {
  const dirs = Object.keys(files);
  return `${dirs.map(
    (dir) =>
      `<div class="${
        dir.split(workSpaceDirName)[1] === focusDir ? "dir focus-dir" : "dir"
      }">
        <span class='dir-img'></span>
        ${dir.split(workSpaceDirName)[1]}
      </div>
      <div class="img-list">
      ${files[dir].map((file: string) => {
        const pathOfImg = file.split(workSpaceDirName)[1];
        return `<div class="img-item">
            <div class="img-wrapper" style='background-image: url("${file}")'></div>
            <button class='btn' data-clipboard-text="${cssTpl?.replace(
              "$pathOfImage",
              pathOfImg
            )}">css</button>
            <button class='btn' data-clipboard-text="${jsTpl?.replace(
              "$pathOfImage",
              pathOfImg
            )}">jsx</button>
          </div>`;
      })}
      </div>`
  )}`;
}

// 处理webview的html文件中的连接
function handleWebViewContent(context: any, templatePath: string) {
  const resourcePath = path.join(context.extensionPath, templatePath);
  const dirPath = path.dirname(resourcePath);
  let html = fs.readFileSync(resourcePath, "utf-8");
  // vscode不支持直接加载本地资源，需要替换成其专有路径格式，样式\JS\背景图的路径替换
  html = html.replace(
    /(<link.+?href="|<script.+?src="|<img.+?src="|url\(")(.+?)"/g,
    (m: string, $1: string, $2: string) => {
      return (
        $1 +
        vscode.Uri.file(path.resolve(dirPath, $2))
          .with({ scheme: "vscode-resource" })
          .toString() +
        '"'
      );
    }
  );
  return html;
}

function getTotalNumberOfImages(file: { [key: string]: string[] }): string {
  const arrs = Object.values(file);
  return (
    arrs.reduce((total, item) => {
      return total + item.length;
    }, 0) + ""
  );
}
