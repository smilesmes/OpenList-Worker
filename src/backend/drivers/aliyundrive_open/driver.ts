import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AliyundriveOpenAddition, AliyunFileItem } from "./types"
import { AliyunOpenClient } from "./util"

function aliyunFileToFileItem(f: AliyunFileItem): FileItem {
  const isDir = f.type === "folder"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.updated_at || f.created_at || new Date().toISOString(),
    sign: "",
    type: calcFileType(f.name, isDir),
    thumb: f.thumbnail || "",
    raw_url: f.download_url || "",
  }
}

export class AliyundriveOpen implements StorageDriver {
  private client: AliyunOpenClient
  private addition: AliyundriveOpenAddition
  private pathFileIdCache = new Map<string, string>()

  constructor(addition: AliyundriveOpenAddition) {
    this.addition = addition
    this.client = new AliyunOpenClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFileId(physicalPath)
    const files = await this.client.listFiles(folderId)
    const items = files.map(aliyunFileToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const fileId = await this.resolveFileId(physicalPath)
    const file = await this.client.getFile(fileId).catch(() => null)
    const url = await this.client.getDownloadUrl(fileId).catch(() => "")

    if (file) {
      const item = aliyunFileToFileItem(file)
      item.raw_url = url || item.raw_url
      return item
    }

    // Fallback: the path may be a folder that isn't listed in its parent
    // (e.g. the storage root). Probe it by listing — if it lists, it's a folder.
    try {
      await this.client.listFiles(fileId)
      const parts = physicalPath.split("/").filter(Boolean)
      const name = parts[parts.length - 1] || "root"
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {}

    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: "",
      type: 0,
      raw_url: url,
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "新文件夹"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFileId(parentPath)
    await this.client.mkdir(parentId, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.rename(fileId, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.remove(fileId)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstId = await this.resolveFileId(dstDir)
    await this.client.move(fileId, dstId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstId = await this.resolveFileId(dstDir)
    await this.client.copy(fileId, dstId)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "upload"
    const parentPath = "/" + parts.join("/")

    // 大文件自动走分片会话：整文件 putFile 会把整个 Buffer 交给单次 PUT，
    // 受 Worker 内存与 CF 请求体限制。这里按 20MB 切分（与阿里云盘默认
    // part size 一致），复用 createUploadSession / uploadPart /
    // completeUploadSession 链路。hintChunkSize 不传，走驱动内部默认。
    const chunkSize = AliyunOpenClient.calPartSize(content.length)
    if (content.length > chunkSize) {
      const info = await this.client.createUploadSession(
        parentPath,
        name,
        content.length,
      )
      if (!info.reuse) {
        const partCount = Math.ceil(content.length / info.chunkSize)
        for (let i = 0; i < partCount; i++) {
          const start = i * info.chunkSize
          const chunk = content.subarray(
            start,
            Math.min(start + info.chunkSize, content.length),
          )
          await this.client.uploadPart(info.session, i + 1, chunk)
        }
        await this.client.completeUploadSession(info.session)
      }
      return
    }

    const parentId = await this.resolveFileId(parentPath)
    await this.client.putFile(parentId, name, content)
  }

  // ---- 分片会话上传（对齐上游 Go 版与 189/123Pan 驱动的接口形状）----
  //
  // 前端流程：
  //   POST /api/fs/upload/create  -> { reuse, partCount, chunkSize, session }
  //   PUT  /api/fs/upload/part    -> 逐片（header 带 X-Upload-Session / X-Part-Number）
  //   POST /api/fs/upload/complete
  //
  // 关键：session 由 createUploadSession 序列化后交给前端带回，Worker 侧
  // 不保留任何内存状态（无状态运行时，冷启动/换实例都不能丢会话）。

  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
    md5: string,
    hintChunkSize = 0,
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    session: string
  }> {
    const info = await this.client.createUploadSession(
      physicalDir || "/",
      fileName,
      size,
      hintChunkSize,
    )
    return {
      reuse: info.reuse,
      partCount: info.partCount,
      chunkSize: info.chunkSize,
      session: info.session,
    }
  }

  async uploadPart(
    session: string,
    partNumber: number,
    content: Buffer,
  ): Promise<{ partMd5: string }> {
    await this.client.uploadPart(session, partNumber, content)
    // 阿里云盘的 complete 不需要分片 MD5；返回空串保持接口形状一致，
    // 避免上层把 undefined 传下去。
    return { partMd5: "" }
  }

  async completeUploadSession(
    session: string,
    _partMd5s: string[] = [],
  ): Promise<void> {
    await this.client.completeUploadSession(session)
  }

  private async resolveFileId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootFolderId()
    if (this.pathFileIdCache.has(clean)) return this.pathFileIdCache.get(clean)!
    const parts = clean.split("/")
    let currentId = this.client.getRootFolderId()
    for (let i = 0; i < parts.length; i++) {
      const rawPart = parts[i]
      const decodedPart = (() => {
        try {
          return decodeURIComponent(rawPart)
        } catch {
          return rawPart
        }
      })()
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathFileIdCache.has(subPath)) {
        currentId = this.pathFileIdCache.get(subPath)!
        continue
      }
      const items = await this.client.listFiles(currentId)
      const target = items.find(
        (f) =>
          f.name === rawPart || f.name === decodedPart || f.file_id === rawPart,
      )
      if (!target)
        throw new Error(`[AliyundriveOpen] Path '${rawPart}' not found`)
      currentId = target.file_id
      this.pathFileIdCache.set(subPath, currentId)
    }
    return currentId
  }
}
