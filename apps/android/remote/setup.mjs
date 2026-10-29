import { parseArgs } from "node:util";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  access,
  rename,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { digest, UUID } from "./protocol.mjs";

const { values: o } = parseArgs({
  options: {
    ...Object.fromEntries(
      [
        "root",
        "core",
        "node",
        "url",
        "keytool",
        "label",
        "revoke",
        "bind",
        "port",
      ].map((k) => [k, { type: "string" }]),
    ),
    "new-device": { type: "boolean" },
  },
});
if (!o.root) throw new Error("需要 --root 指定私有服务数据目录");
const root = resolve(o.root);
await mkdir(root, { recursive: true, mode: 0o700 });
if (process.platform === "win32") {
  const who = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sid = who.stdout?.match(/S-1-5-[0-9-]+/)?.[0];
  if (!sid) throw new Error("无法确认本机账户 SID");
  const acl = spawnSync(
    "icacls.exe",
    [
      root,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (acl.status !== 0) throw new Error("无法保护连接密钥目录");
}
const path = join(root, "server.json");
let config;
try {
  config = JSON.parse(await readFile(path, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
async function saveConfig() {
  const temp = join(root, `server-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(config, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temp, path);
}
if (config && !o.revoke && !o["new-device"]) {
  if (o.url && new URL(o.url).origin !== config.publicUrl)
    throw new Error(
      "已有服务使用其他连接地址；请备份并调整 server.json 的 publicUrl 与手机导入配置，保持证书和密钥不变。",
    );
  const device = config.devices[0];
  if (!device) throw new Error("没有活动设备；使用 --new-device 创建新的连接");
  const connectionFile = join(root, `rea-connection-${device.id}.json`);
  const saved = JSON.parse(await readFile(connectionFile, "utf8"));
  if (digest(saved.token) !== device.tokenHash)
    throw new Error(
      "已有连接文件不匹配；请保留现场并使用 --new-device 新建设备",
    );
  console.log(
    JSON.stringify(
      {
        connectionFile,
        deviceId: device.id,
        url: config.publicUrl,
        reused: true,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (o.revoke) {
  if (
    !config ||
    !UUID.test(o.revoke) ||
    !config.devices.some((d) => d.id === o.revoke)
  )
    throw new Error("设备编号不存在");
  await copyFile(path, join(root, `server.backup-${Date.now()}.json`));
  config.devices = config.devices.filter((d) => d.id !== o.revoke);
  await saveConfig();
  console.log("已撤销设备；重启连接服务后生效。");
} else {
  if (!config) {
    if (!o.url || !o.core || !o.node || !o.keytool)
      throw new Error("首次配置需要 --url --core --node --keytool");
    const url = new URL(o.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("连接地址必须是 HTTPS 根地址");
    const port = Number(o.port ?? url.port ?? 8443) || 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("端口无效");
    const coreRoot = resolve(o.core),
      node = resolve(o.node);
    await access(join(coreRoot, "dist/composition/cli.js")).catch(() =>
      access(join(coreRoot, "scripts/rea.mjs")),
    );
    await access(node);
    const password = randomBytes(32).toString("hex");
    const passFile = join(root, "tls-password.txt");
    await writeFile(passFile, password, { flag: "wx", mode: 0o600 });
    const certFile = join(root, "server.cer"),
      pfx = join(root, "server.p12");
    const run = (args) => {
      const r = spawnSync(o.keytool, args, {
        encoding: "utf8",
        windowsHide: true,
      });
      if (r.status !== 0) throw new Error("本机 TLS 证书生成失败：" + r.stderr);
    };
    run([
      "-genkeypair",
      "-alias",
      "rea-mobile",
      "-keyalg",
      "RSA",
      "-keysize",
      "3072",
      "-validity",
      "3650",
      "-dname",
      "CN=REA Mobile Private Server",
      "-storetype",
      "PKCS12",
      "-keystore",
      pfx,
      "-storepass:file",
      passFile,
      "-keypass:file",
      passFile,
    ]);
    run([
      "-exportcert",
      "-alias",
      "rea-mobile",
      "-keystore",
      pfx,
      "-storepass:file",
      passFile,
      "-file",
      certFile,
    ]);
    const certificateSha256 = new X509Certificate(
      await readFile(certFile),
    ).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    config = {
      protocol: 1,
      bind: o.bind ?? "0.0.0.0",
      port,
      publicUrl: url.origin,
      coreRoot,
      node,
      tlsPassword: password,
      certificateSha256,
      devices: [],
    };
  } else {
    await copyFile(path, join(root, `server.backup-${Date.now()}.json`));
  }
  if (config.devices.length >= 4)
    throw new Error("最多配置 4 台设备，请先撤销不再使用的设备");
  const token = randomBytes(32).toString("hex"),
    id = randomUUID(),
    label = o.label ?? "REA 电脑";
  config.devices.push({ id, label, tokenHash: digest(token) });
  const pairingPath = join(root, `rea-connection-${id}.json`);
  await writeFile(
    pairingPath,
    JSON.stringify(
      {
        protocol: 1,
        deviceId: id,
        label,
        url: config.publicUrl,
        certificateSha256: config.certificateSha256,
        token,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await saveConfig();
  console.log(
    JSON.stringify(
      {
        connectionFile: pairingPath,
        deviceId: id,
        url: config.publicUrl,
        notice:
          "连接配置含设备密钥，仅传给自己的手机。配置变更后需重启服务；不要提交这些文件。",
      },
      null,
      2,
    ),
  );
}
