import {
  AliyundriveOpenAddition,
  AliyunTokenResp,
  AliyunFileItem,
} from "./types"
import { assertSafeUrl } from "../../pkg/http"

const ALI_OPEN_API = "https://openapi.aliyundrive.com/adrive/v1.0"

// ============================================================
// AliyunOpenClient - 阿里云盘 OAuth2 OpenAPI 客户端
// 优先通过在线 API 中转（GET + query params），
// 备用直连 OAuth 端点（需要 client_id + client_secret）
// ============================================================
export class AliyunOpenClient {
  private addition: AliyundriveOpenAddition
  private accessToken: string = ""
  private refreshTokenVal: string = ""
  public driveId: string = ""
  private tokenExpiresAt: number = 0

  constructor(addition: AliyundriveOpenAddition) {
    this.addition = addition
    this.refreshTokenVal = addition.refresh_token || ""
    this.driveId = addition.drive_id || ""
  }

  public async init(): Promise<void> {
    if (!this.refreshTokenVal || !this.refreshTokenVal.trim()) {
      console.warn("[AliyundriveOpen] refresh_token is empty, skipping init.")
      return
    }
    try {
      await this.refreshAccessToken()
      if (!this.driveId) {
        await this.resolveDriveId()
      }
    } catch (e: any) {
      console.warn("[AliyundriveOpen] init warning:", e.message)
    }
  }

  private async resolveDriveId(forceResource = false): Promise<void> {
    if (
      !forceResource &&
      this.addition.drive_id &&
      this.addition.drive_id.trim()
    ) {
      this.driveId = this.addition.drive_id.trim()
      return
    }

    try {
      const res = await this.openApiRequest<any>("/user/getDriveInfo", {})
      const driveType = forceResource
        ? "resource"
        : this.addition.drive_type || "resource"

      let pickedDriveId = ""
      if (driveType === "resource" && res.resource_drive_id) {
        pickedDriveId = res.resource_drive_id
      } else if (driveType === "backup" && res.backup_drive_id) {
        pickedDriveId = res.backup_drive_id
      } else if (driveType === "default" && res.default_drive_id) {
        pickedDriveId = res.default_drive_id
      }

      if (!pickedDriveId) {
        pickedDriveId =
          res.resource_drive_id ||
          res.default_drive_id ||
          res.backup_drive_id ||
          ""
      }

      this.driveId = pickedDriveId
      console.log(
        `[AliyundriveOpen] Resolved drive_id: ${this.driveId} (driveType: ${driveType})`,
      )
    } catch (e: any) {
      console.warn("[AliyundriveOpen] resolveDriveId failed:", e.message)
    }
  }

  public async refreshAccessToken(): Promise<void> {
    if (!this.refreshTokenVal || !this.refreshTokenVal.trim()) {
      return
    }
    const token = this.refreshTokenVal.trim()

    // 策略1: 通过在线 API 中转（GET + query params）
    const onlineApis: string[] = []
    if (this.addition.api_url_address && this.addition.api_url_address.trim()) {
      const customApi = this.addition.api_url_address.trim()
      // FIX(H-2): api_url_address 是管理员可配置字段，会把用户 refresh_token
      // 发给该 URL。必须先做 SSRF 校验，否则可被配置成内网/元数据地址导致
      // token 外泄。不安全时跳过该自定义地址，继续使用内置受信地址。
      try {
        assertSafeUrl(customApi, "AliyundriveOpen api_url_address")
        onlineApis.push(customApi)
      } catch (e: any) {
        console.warn(
          `[AliyundriveOpen] Skipping unsafe api_url_address: ${e.message}`,
        )
      }
    }
    onlineApis.push(
      "https://api.oplist.org/alicloud/renewapi",
      "https://api.oplist.org/ali_open/token",
      "https://api.oplist.org/aliyundrive/token",
      "https://api.alist.nn.ci/alist/ali_open/token",
      "https://api.alist.nn.ci/aliyundrive/token",
      "https://api-sam.oplist.org/aliyundrive/token",
    )

    const driverTxt =
      this.addition.alipan_type === "alipanTV" ? "alicloud_tv" : "alicloud_qr"

    for (const apiUrl of onlineApis) {
      try {
        const params = new URLSearchParams({
          refresh_ui: token,
          refresh_token: token,
          server_use: "true",
          driver_txt: driverTxt,
        })
        const res = await fetch(`${apiUrl}?${params.toString()}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        })
        if (!res.ok) {
          throw new Error(`[Status ${res.status}]`)
        }
        const data: any = await res.json()
        const newToken: string =
          data.refresh_token || data.data?.refresh_token || ""
        const newAccess: string =
          data.access_token || data.data?.access_token || ""
        if (!newAccess) {
          throw new Error(
            `Empty access_token from online API: ${JSON.stringify(data)}`,
          )
        }
        this.accessToken = newAccess
        if (newToken) this.refreshTokenVal = newToken
        this.tokenExpiresAt =
          Date.now() + (data.expires_in || 7200) * 1000 - 60000
        return // Success!
      } catch (err: any) {
        console.warn(
          `[AliyundriveOpen] Online API '${apiUrl}' failed: ${err.message}`,
        )
      }
    }

    // 策略2: 直连 OpenAPI OAuth（需要 client_id + client_secret，或默认 Client ID）
    const clientId =
      (this.addition.client_id || "").trim() ||
      "25ab4837190e48718a28f80073574a4d"
    const clientSecret = (this.addition.client_secret || "").trim()

    try {
      const payload: any = {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
      }
      if (clientSecret) payload.client_secret = clientSecret

      const res = await fetch(
        "https://openapi.aliyundrive.com/oauth/access_token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`[Status ${res.status}] ${text}`)
      }
      const data: AliyunTokenResp = await res.json()
      if (!data.access_token) {
        throw new Error(`Invalid response: ${JSON.stringify(data)}`)
      }
      this.accessToken = data.access_token
      if (data.refresh_token) this.refreshTokenVal = data.refresh_token
      this.tokenExpiresAt =
        Date.now() + (data.expires_in || 7200) * 1000 - 60000
      return // Success!
    } catch (err: any) {
      console.warn(`[AliyundriveOpen] Direct OAuth failed: ${err.message}`)
    }

    throw new Error(
      "[AliyundriveOpen] All token refresh strategies failed. " +
        "Please check: 1) refresh_token is valid and not expired, " +
        "2) api_url_address is accessible, " +
        "3) If using direct OAuth, client_id and client_secret are correct.",
    )
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken()
    }
  }

  public getRootFolderId(): string {
    return this.addition.root_folder_id?.trim() || "root"
  }

  public async openApiRequest<T = any>(
    path: string,
    body: any,
    retry = true,
  ): Promise<T> {
    await this.ensureToken()
    const url = path.startsWith("http") ? path : `${ALI_OPEN_API}${path}`
    // FIX(H-2): path 以 http 开头时是调用方传入的绝对 URL，必须做 SSRF 校验
    try {
      assertSafeUrl(url, "AliyundriveOpen openApiRequest")
    } catch (e: any) {
      throw new Error(`[AliyundriveOpen] blocked unsafe URL: ${e.message}`)
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    })
    if (res.status === 401 && retry) {
      await this.refreshAccessToken()
      return this.openApiRequest<T>(path, body, false)
    }
    if (!res.ok) {
      const err = await res.text().catch(() => "")
      throw new Error(
        `[AliyundriveOpen] API error [${res.status}] ${path}: ${err}`,
      )
    }
    return res.json()
  }

  public async listFiles(parentFileId: string): Promise<AliyunFileItem[]> {
    if (!this.driveId) {
      await this.resolveDriveId()
    }
    const items: AliyunFileItem[] = []
    let marker: string | undefined
    const orderBy = this.addition.order_by || "updated_at"
    const orderDirection = this.addition.order_direction || "DESC"
    do {
      const body: any = {
        drive_id: this.driveId,
        parent_file_id: parentFileId,
        limit: 100,
        order_by: orderBy,
        order_direction: orderDirection,
      }
      if (marker) body.marker = marker

      let resp: any
      try {
        resp = await this.openApiRequest<any>("/openFile/list", body)
      } catch (err: any) {
        if (err.message?.includes("UserNotAllowedAccessDrive")) {
          console.warn(
            `[AliyundriveOpen] UserNotAllowedAccessDrive for drive ${this.driveId}, auto re-resolving drive_id...`,
          )
          await this.resolveDriveId(true)
          body.drive_id = this.driveId
          resp = await this.openApiRequest<any>("/openFile/list", body)
        } else {
          throw err
        }
      }

      items.push(...(resp.items || []))
      marker = resp.next_marker || undefined
    } while (marker)
    return items
  }

  public async getFile(fileId: string): Promise<AliyunFileItem> {
    if (!this.driveId) {
      await this.resolveDriveId()
    }
    return this.openApiRequest<AliyunFileItem>("/openFile/get", {
      drive_id: this.driveId,
      file_id: fileId,
    })
  }

  public async getDownloadUrl(fileId: string): Promise<string> {
    const resp = await this.openApiRequest<any>("/openFile/getDownloadUrl", {
      drive_id: this.driveId,
      file_id: fileId,
      expire_sec: 14400,
    })
    return resp.url || resp.download_url || ""
  }

  public async mkdir(parentFileId: string, name: string): Promise<void> {
    await this.openApiRequest("/openFile/create", {
      drive_id: this.driveId,
      parent_file_id: parentFileId,
      name,
      type: "folder",
      check_name_mode: "refuse",
    })
  }

  public async rename(fileId: string, newName: string): Promise<void> {
    await this.openApiRequest("/openFile/update", {
      drive_id: this.driveId,
      file_id: fileId,
      name: newName,
      check_name_mode: "refuse",
    })
  }

  public async remove(fileId: string): Promise<void> {
    const way = this.addition.remove_way || "trash"
    await this.openApiRequest(
      way === "trash" ? "/openFile/recyclebin" : "/openFile/delete",
      { drive_id: this.driveId, file_id: fileId },
    )
  }

  public async move(fileId: string, toParentFileId: string): Promise<void> {
    await this.openApiRequest("/openFile/move", {
      drive_id: this.driveId,
      file_id: fileId,
      to_parent_file_id: toParentFileId,
      check_name_mode: "refuse",
    })
  }

  public async copy(fileId: string, toParentFileId: string): Promise<void> {
    await this.openApiRequest("/openFile/copy", {
      drive_id: this.driveId,
      file_id: fileId,
      to_parent_file_id: toParentFileId,
      auto_rename: true,
    })
  }

  public async putFile(
    parentFileId: string,
    filename: string,
    content: Buffer,
  ): Promise<void> {
    const size = content.length
    const createResp = await this.openApiRequest<any>("/openFile/create", {
      drive_id: this.driveId,
      parent_file_id: parentFileId,
      name: filename,
      type: "file",
      size,
      check_name_mode: "auto_rename",
      part_info_list: [{ part_number: 1 }],
    })
    const uploadUrl = createResp.part_info_list?.[0]?.upload_url
    if (!uploadUrl) return
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      body: content as any,
    })
    if (!putRes.ok) {
      throw new Error(`[AliyundriveOpen] Upload failed: ${putRes.status}`)
    }
    await this.openApiRequest("/openFile/complete", {
      drive_id: this.driveId,
      file_id: createResp.file_id,
      upload_id: createResp.upload_id,
    })
  }

  // ============================================================
  // 分片上传（对齐上游 Go 版 drivers/aliyundrive_open/upload.go）
  //
  // 流程：create（一次性申请全部分片 URL）→ 逐片 PUT → complete
  // 关键点（来自上游实现）：
  //   - 分片大小由文件大小反推，默认 20MB，需保证片数 ≤ 10000
  //   - complete 只需 drive_id / file_id / upload_id，不需要每片 MD5
  //   - 分片 PUT 接受 200 与 409（409 表示该片已存在）
  //   - 上传 URL 有时效，上游每 50 分钟重新申请一次
  // ============================================================

  /** 上游 calPartSize：默认 20MB，大文件按 10000 片上限反推 */
  public static calPartSize(fileSize: number): number {
    const MB = 1024 * 1024
    const GB = 1024 * MB
    const TB = 1024 * GB
    let partSize = 20 * MB
    if (fileSize > partSize) {
      if (fileSize > 1 * TB) {
        partSize = 5 * GB
      } else if (fileSize > 768 * GB) {
        partSize = 109951163
      } else if (fileSize > 512 * GB) {
        partSize = 82463373
      } else if (fileSize > 384 * GB) {
        partSize = 54975582
      } else if (fileSize > 256 * GB) {
        partSize = 41231687
      } else if (fileSize > 128 * GB) {
        partSize = 27487791
      }
    }
    return partSize
  }

  /** 上游 makePartInfos：part_number 从 1 开始 */
  private static makePartInfos(count: number): Array<{ part_number: number }> {
    const list: Array<{ part_number: number }> = []
    for (let i = 0; i < count; i++) {
      list.push({ part_number: i + 1 })
    }
    return list
  }

  /**
   * 创建分片上传会话。
   *
   * 返回的 session 是 Base64(JSON)，携带后续 uploadPart / complete 所需的
   * 全部信息。Worker 无状态，会话必须由前端带回，因此这里序列化而非存内存。
   */
  public async createUploadSession(
    physicalDir: string,
    fileName: string,
    size: number,
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    session: string
    parentFileId: string
  }> {
    if (!this.driveId) {
      await this.resolveDriveId()
    }
    const parentFileId = await this.resolveFolderId(physicalDir || "/")
    const partSize = AliyunOpenClient.calPartSize(size)
    const partCount = Math.max(1, Math.ceil(size / partSize))

    const createResp = await this.openApiRequest<any>("/openFile/create", {
      drive_id: this.driveId,
      parent_file_id: parentFileId,
      name: fileName,
      type: "file",
      size,
      check_name_mode: "auto_rename",
      part_info_list: AliyunOpenClient.makePartInfos(partCount),
    })

    // 秒传命中：阿里云盘直接返回 rapid_upload，无需再传分片
    if (createResp?.rapid_upload === true) {
      return {
        reuse: true,
        partCount: 0,
        chunkSize: partSize,
        session: "",
        parentFileId,
      }
    }

    const partInfoList: any[] = Array.isArray(createResp?.part_info_list)
      ? createResp.part_info_list
      : []
    if (partInfoList.length === 0) {
      throw new Error(
        "[AliyundriveOpen] create did not return part_info_list; " +
          "cannot start chunked upload",
      )
    }

    const session = Buffer.from(
      JSON.stringify({
        driveId: this.driveId,
        fileId: createResp.file_id,
        uploadId: createResp.upload_id,
        partCount: partInfoList.length,
        chunkSize: partSize,
        size,
        // 上传 URL 一次性拿全，减少往返
        uploadUrls: partInfoList.map((p: any) => String(p?.upload_url || "")),
      }),
      "utf8",
    ).toString("base64")

    return {
      reuse: false,
      partCount: partInfoList.length,
      chunkSize: partSize,
      session,
      parentFileId,
    }
  }

  /** 上传单个分片。partNumber 从 1 开始。 */
  public async uploadPart(
    sessionToken: string,
    partNumber: number,
    content: Buffer,
  ): Promise<void> {
    const session = this.decodeUploadSession(sessionToken)
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.partCount
    ) {
      throw new Error(`[AliyundriveOpen] 分片序号无效: ${partNumber}`)
    }
    const uploadUrl = session.uploadUrls[partNumber - 1]
    if (!uploadUrl) {
      throw new Error(
        `[AliyundriveOpen] 分片 ${partNumber} 缺少上传地址，请重新发起上传`,
      )
    }
    const res = await fetch(uploadUrl, {
      method: "PUT",
      body: content as any,
    })
    // 上游接受 200 与 409（409 = 该分片已存在，幂等重传时会出现）
    if (res.status !== 200 && res.status !== 409) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `[AliyundriveOpen] 上传第 ${partNumber}/${session.partCount} 分片失败: HTTP ${res.status} ${text}`,
      )
    }
  }

  /** 完成上传会话。阿里云盘的 complete 不需要每片 MD5。 */
  public async completeUploadSession(sessionToken: string): Promise<void> {
    const session = this.decodeUploadSession(sessionToken)
    await this.openApiRequest("/openFile/complete", {
      drive_id: session.driveId,
      file_id: session.fileId,
      upload_id: session.uploadId,
    })
  }

  private decodeUploadSession(token: string): {
    driveId: string
    fileId: string
    uploadId: string
    partCount: number
    chunkSize: number
    size: number
    uploadUrls: string[]
  } {
    try {
      const session = JSON.parse(
        Buffer.from(token, "base64").toString("utf8"),
      )
      if (
        !session ||
        !session.fileId ||
        !session.uploadId ||
        !Number.isInteger(session.partCount) ||
        session.partCount < 1 ||
        !Array.isArray(session.uploadUrls)
      ) {
        throw new Error("invalid upload session")
      }
      return session
    } catch {
      throw new Error("[AliyundriveOpen] 上传会话无效或已损坏")
    }
  }

  /**
   * 解析物理目录路径 -> file_id（分片上传定位父目录用）。
   *
   * 与 driver.ts 的 resolveFileId 分开实现：这里只在本类内部使用，
   * 不共享 driver 侧的 pathFileIdCache，避免两个缓存互相污染。
   */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = String(physicalPath || "/")
      .split("/")
      .filter(Boolean)
      .join("/")
    if (!clean) return this.getRootFolderId()
    const parts = clean.split("/")
    let currentId = this.getRootFolderId()
    for (const part of parts) {
      const decodedPart = (() => {
        try {
          return decodeURIComponent(part)
        } catch {
          return part
        }
      })()
      const items = await this.listFiles(currentId)
      const target = items.find(
        (f: any) =>
          f.name === part || f.name === decodedPart || f.file_id === part,
      )
      if (!target) {
        throw new Error(`[AliyundriveOpen] 父目录不存在: ${physicalPath}`)
      }
      currentId = target.file_id
    }
    return currentId
  }
}
