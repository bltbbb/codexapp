const { createApp, nextTick, ref } = Vue;
const {
  showFailToast,
  showSuccessToast,
  showConfirmDialog,
  ImagePreview,
} = vant;

function makeClientId(prefix = 'id') {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 简单的 Markdown 代码块解析
 * 将 ```...``` 包裹的内容渲染为代码块，其余文本保持原样
 */
function parseMessageSegments(text) {
  if (!text) return [{ type: 'text', content: '' }];
  const segments = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    // 去掉 ``` 标记
    let code = match[0].slice(3, -3);
    // 去掉可能的语言标识（第一行）
    const firstNewline = code.indexOf('\n');
    if (firstNewline > -1 && firstNewline < 20 && !/\s/.test(code.slice(0, firstNewline))) {
      code = code.slice(firstNewline + 1);
    }
    segments.push({ type: 'code', content: code.trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }
  return segments.length ? segments : [{ type: 'text', content: text }];
}

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function getCommandPrimaryToken(commandText) {
  const text = String(commandText || '').trim();
  if (!text) {
    return '';
  }

  if (
    text.startsWith('$')
    || text.startsWith('@')
    || /^(Get-|Set-|Select-|Where-|ForEach-|Start-|Stop-|New-|Remove-|Invoke-|Test-|Write-|Out-|ConvertTo-|ConvertFrom-)/i.test(text)
  ) {
    return 'powershell';
  }

  const match = text.match(/^(&\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return stripWrappingQuotes(match?.[2] || match?.[3] || match?.[4] || '');
}

function splitCommandArguments(commandText) {
  const text = String(commandText || '').trim();
  if (!text) {
    return [];
  }

  const matches = text.match(/"[^"]*"|'[^']*'|[^\s]+/g);
  return Array.isArray(matches) ? matches.map((item) => stripWrappingQuotes(item)) : [];
}

const MESSAGE_PAGE_SIZE = 60;
const MESSAGE_TOP_LOAD_THRESHOLD = 96;

createApp({
  template: `
    <van-config-provider theme="light">
      <div
        class="wc-app"
        :class="{
          'wc-app-mobile-docked': isMobileView && currentSession,
          'wc-app-mobile-with-composer': isMobileView && showComposer,
          'wc-app-standalone': isStandaloneApp
        }"
      >

        <!-- ===== 桌面端侧边栏 ===== -->
        <aside class="wc-sidebar-desktop">
          <div class="wc-sidebar-sheet">
            <section class="wc-brand-card">
              <p class="wc-eyebrow">Mobile Remote Console</p>
              <h1 class="wc-brand-title">Codex 会话台</h1>
              <p class="wc-brand-copy">用更像聊天工具的方式管理本机 Codex，会话切换、续聊、盯进度。</p>
            </section>
            <section class="wc-sidebar-card">
              <div class="wc-section-head">
                <h2 class="wc-panel-title">访问令牌</h2>
                <div class="wc-section-actions">
                  <van-button size="small" plain round type="primary" @click="toggleTokenEditor">
                    {{ tokenEditorOpen ? '收起' : '更换' }}
                  </van-button>
                  <van-button v-if="tokenEditorOpen" size="small" round type="primary" @click="saveToken">
                    保存
                  </van-button>
                </div>
              </div>
              <p :class="['wc-token-status', tokenStatusOk ? 'wc-token-ok' : 'wc-token-error']">{{ tokenStatusText }}</p>
              <div :class="['wc-token-editor', tokenEditorOpen ? '' : 'collapsed']">
                <van-field
                  v-model="draftToken"
                  type="password"
                  label="令牌"
                  placeholder="请输入访问令牌"
                  autocomplete="off"
                />
              </div>
            </section>
            <section class="wc-sidebar-card">
              <div class="wc-section-head">
                <h2 class="wc-panel-title">推送状态</h2>
                <div class="wc-section-actions">
                  <van-button size="small" plain round :disabled="!token || pushLoading" @click="refreshPushStatus">
                    刷新
                  </van-button>
                </div>
              </div>
              <div v-if="!token" class="wc-empty-box" style="min-height:72px;padding:16px;">
                <span class="wc-empty-text">先填写访问令牌，再查看设备注册状态。</span>
              </div>
              <div v-else class="wc-push-summary">
                <p :class="['wc-token-status', pushSummary?.configured ? 'wc-token-ok' : 'wc-token-error']">
                  {{ pushSummaryText }}
                </p>
                <div class="wc-push-badges" v-if="pushSummary">
                  <span class="wc-mini-badge">{{ pushEnvironmentText }}</span>
                  <span class="wc-mini-badge">已注册 {{ pushSummary.deviceCount || 0 }} 台</span>
                  <span class="wc-mini-badge">启用 {{ pushSummary.enabledDeviceCount || 0 }} 台</span>
                </div>
                <div v-if="pushLoading" class="wc-empty-box" style="min-height:72px;padding:16px;">
                  <span class="wc-empty-text">正在读取推送状态…</span>
                </div>
                <div v-else-if="pushDevices.length" class="wc-push-device-list">
                  <article v-for="device in pushDevices" :key="device.id" class="wc-push-device">
                    <div class="wc-push-device-head">
                      <div class="wc-push-device-meta">
                        <strong class="wc-push-device-title">{{ device.deviceName || '未命名设备' }}</strong>
                        <span class="wc-push-device-token">{{ device.tokenMasked || '无 token' }}</span>
                      </div>
                      <span class="wc-push-device-status" :class="{ disabled: !device.pushEnabled || device.invalidatedAt }">
                        {{ pushDeviceStatusText(device) }}
                      </span>
                    </div>
                    <div class="wc-push-device-actions">
                      <span class="wc-push-device-note">{{ device.bundleId || '未登记 Bundle ID' }}</span>
                      <van-button
                        size="small"
                        round
                        plain
                        type="primary"
                        :loading="pushTestingDeviceId === device.id"
                        @click="sendPushTest(device)"
                      >
                        测试通知
                      </van-button>
                    </div>
                  </article>
                </div>
                <div v-else class="wc-empty-box" style="min-height:72px;padding:16px;">
                  <span class="wc-empty-text">还没有 iOS 设备注册到当前服务。</span>
                </div>
              </div>
            </section>
            <section class="wc-sidebar-card" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
              <div class="wc-section-head">
                <h2 class="wc-panel-title">会话列表</h2>
                <div class="wc-section-actions">
                  <van-button size="small" plain round @click="refreshSessions">刷新</van-button>
                  <van-button size="small" round type="primary" @click="createSession">新建</van-button>
                </div>
              </div>
              <div v-if="!token" class="wc-empty-box" style="min-height:80px;padding:16px;">
                <span class="wc-empty-text">先填写访问令牌。</span>
              </div>
              <div v-else-if="!sessions.length" class="wc-empty-box" style="min-height:80px;padding:16px;">
                <span class="wc-empty-text">还没有可展示的会话。</span>
              </div>
              <div v-else class="wc-session-list" style="flex:1;">
                <button
                  v-for="session in sessions"
                  :key="session.id"
                  class="wc-session-item"
                  :class="{ active: session.id === currentSessionId }"
                  @click="openSession(session.id)"
                >
                  <div class="wc-session-item-head">
                    <span class="wc-session-title">{{ session.title || '未命名会话' }}</span>
                    <span class="wc-session-source">{{ sourceLabel(session.source) }}</span>
                  </div>
                  <p class="wc-session-preview">{{ session.preview || '暂无摘要' }}</p>
                  <div class="wc-session-item-foot">
                    <span class="wc-session-foot-item">{{ statusText(session.status) }}</span>
                    <span class="wc-session-foot-item">{{ formatTime(session.updatedAt) }}</span>
                  </div>
                </button>
              </div>
            </section>
          </div>
        </aside>

        <!-- ===== 移动端顶栏 ===== -->
        <header class="wc-mobile-topbar wc-mobile-only">
          <div class="wc-topbar-left">
            <van-button icon="bars" size="small" round plain @click="mobileSidebarVisible = true" />
          </div>
          <div class="wc-topbar-center">
            <h2 class="wc-topbar-title">{{ currentSession ? currentSession.title : 'Codex 会话台' }}</h2>
            <p v-if="currentSession" class="wc-topbar-subtitle">
              <span :class="['wc-status-pill', statusClass(currentSession.status)]">
                {{ statusText(currentSession.status) }}
              </span>
            </p>
          </div>
          <div class="wc-topbar-right">
            <van-button
              v-if="currentSession && isRunning"
              icon="pause-circle-o"
              size="small"
              round
              type="danger"
              @click="stopSession"
            />
            <van-popover v-model:show="mobileMenuVisible" :actions="mobileMenuActions" @select="onMobileMenuSelect" placement="bottom-end">
              <template #reference>
                <van-button icon="ellipsis" size="small" round plain />
              </template>
            </van-popover>
          </div>
        </header>

        <!-- ===== 主内容 ===== -->
        <main class="wc-main">

          <!-- 桌面端 header（移动端隐藏） -->
          <div class="wc-desktop-header" v-if="!isMobileView">
            <div class="wc-desktop-header-row">
              <div>
                <h2 class="wc-desktop-header-title">{{ currentSession ? currentSession.title : '未选择会话' }}</h2>
                <p class="wc-desktop-header-meta">{{ sessionMetaText }}</p>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span :class="['wc-status-pill', statusClass(currentSession ? currentSession.status : 'idle')]">
                  {{ statusText(currentSession ? currentSession.status : 'idle') }}
                </span>
                <van-button round plain type="danger" size="small" :disabled="!currentSession || isRunning" @click="deleteSession">
                  删除
                </van-button>
                <van-button round type="primary" size="small" :disabled="!currentSession || !isRunning" @click="stopSession">
                  停止
                </van-button>
              </div>
            </div>
          </div>

          <!-- 桌面端 Tab 栏 -->
          <div class="wc-desktop-tabs" v-if="!isMobileView">
            <van-tabs v-model:active="activeTab" shrink>
              <van-tab title="消息" name="messages" />
              <van-tab title="事件" name="events" />
              <van-tab title="产物" name="artifacts" />
            </van-tabs>
          </div>

          <!-- Tab 内容 -->
          <div class="wc-tab-content">

            <!-- 骨架屏加载态 -->
            <div v-if="sessionLoading" class="wc-skeleton-wrap wc-skeleton-overlay">
              <van-skeleton title :row="3" />
              <van-skeleton title :row="2" />
              <van-skeleton title :row="4" />
            </div>

            <!-- 消息面板 -->
            <div
              v-show="activeTab === 'messages'"
              ref="chatArea"
              class="wc-chat-area"
              @scroll.passive="handleMessageScroll"
            >
              <div v-if="!currentSession || (!sessionMessages.length && !messageProgressBubble)" class="wc-empty-box">
                <div class="wc-empty-icon">💬</div>
                <p class="wc-empty-text">{{ currentSession ? '发送消息开始对话' : '选择或新建一个会话' }}</p>
              </div>
              <div v-else class="wc-message-list">
                <div
                  v-if="currentSession?.messagePage?.hasMore || loadingOlderMessages"
                  class="wc-message-history-anchor"
                >
                  <span v-if="loadingOlderMessages">正在加载更早消息…</span>
                  <span v-else>上滑加载更早消息</span>
                </div>
                <div
                  v-for="(message, idx) in sessionMessages"
                  :key="message.id || idx"
                  :class="['wc-bubble-row', message.role === 'user' ? 'is-user' : 'is-assistant']"
                  :style="{ animationDelay: (idx * 0.04) + 's' }"
                >
                  <div :class="['wc-bubble-avatar', message.role === 'user' ? 'user-avatar' : 'ai-avatar']">
                    {{ message.role === 'user' ? '你' : 'AI' }}
                  </div>
                  <div>
                    <div :class="['wc-bubble', message.role === 'user' ? 'user-bubble' : 'ai-bubble']" v-html="messageHtml(message)"></div>
                    <div v-if="Array.isArray(message.attachments) && message.attachments.length" class="wc-message-attachments">
                      <button
                        v-for="attachment in message.attachments"
                        :key="attachment.id"
                        type="button"
                        class="wc-message-attachment"
                        @click="openMessageAttachment(attachment)"
                      >
                        <span class="wc-message-attachment-name">{{ attachment.name }}</span>
                        <span class="wc-message-attachment-meta">{{ artifactKindLabel(attachment.kind) }} · {{ formatBytes(attachment.size) }}</span>
                      </button>
                    </div>
                    <div class="wc-bubble-time">{{ formatTime(message.createdAt) }}</div>
                  </div>
                </div>
                <div
                  v-if="messageProgressBubble"
                  class="wc-bubble-row is-status"
                  :class="'tone-' + messageProgressBubble.tone"
                >
                  <div class="wc-bubble-avatar status-avatar" :class="'tone-' + messageProgressBubble.tone">
                    {{ messageProgressBubble.icon }}
                  </div>
                  <div class="wc-status-bubble-wrap">
                    <div class="wc-bubble status-bubble" :class="'tone-' + messageProgressBubble.tone">
                      <div class="wc-status-bubble-head">
                        <span class="wc-status-bubble-stage">{{ messageProgressBubble.stage }}</span>
                        <span v-if="messageProgressBubble.loading" class="wc-status-bubble-loader" aria-hidden="true">
                          <span></span><span></span><span></span>
                        </span>
                      </div>
                      <div class="wc-status-bubble-title">{{ messageProgressBubble.title }}</div>
                      <div v-if="messageProgressBubble.detail" class="wc-status-bubble-detail">
                        {{ messageProgressBubble.detail }}
                      </div>
                    </div>
                    <div class="wc-bubble-time">{{ messageProgressBubble.timeText }}</div>
                  </div>
                </div>
                <div ref="messageBottom" class="wc-message-bottom-anchor"></div>
              </div>
            </div>

            <!-- 事件面板 -->
            <div v-show="activeTab === 'events'" class="wc-event-list">
              <div v-if="!currentSession || !latestEvents.length" class="wc-empty-box">
                <div class="wc-empty-icon">📡</div>
                <p class="wc-empty-text">还没有事件。</p>
              </div>
              <article
                v-for="(event, ei) in latestEvents"
                :key="event.id || ei"
                class="wc-event-card"
                :style="{ animationDelay: (ei * 0.03) + 's' }"
              >
                <div class="wc-event-head">
                  <span :class="['wc-event-type', 'type-' + event.type]">{{ eventTypeLabel(event.type) }}</span>
                  <time class="wc-time">{{ formatTime(event.timestamp) }}</time>
                </div>
                <div class="wc-event-body">{{ eventBodyText(event) }}</div>
              </article>
            </div>

            <!-- 产物面板 -->
            <div v-show="activeTab === 'artifacts'" class="wc-artifact-list">
              <div v-if="!currentSession || !currentSession.artifacts || !currentSession.artifacts.length" class="wc-empty-box">
                <div class="wc-empty-icon">📦</div>
                <p class="wc-empty-text">当前没有产物。</p>
              </div>
              <article
                v-for="artifact in currentSession?.artifacts || []"
                :key="artifact.id"
                class="wc-artifact-card"
              >
                <div class="wc-artifact-preview" v-if="artifact.kind === 'image'">
                  <img
                    :src="fileUrl(artifact.id)"
                    :alt="artifact.name"
                    @click="previewImage(artifact)"
                  />
                </div>
                <div class="wc-artifact-info">
                  <div class="wc-artifact-name">{{ artifact.name }}</div>
                  <p class="wc-artifact-meta">{{ artifactKindLabel(artifact.kind) }} · {{ formatBytes(artifact.size) }} · {{ formatTime(artifact.createdAt) }}</p>
                  <div class="wc-artifact-actions">
                    <van-button size="small" plain round type="primary" @click="openArtifact(artifact)">
                      {{ artifact.kind === 'image' ? '查看原图' : '下载文件' }}
                    </van-button>
                    <van-button
                      v-if="artifact.kind === 'text'"
                      size="small"
                      round
                      type="primary"
                      @click="loadTextPreview(artifact)"
                    >
                      预览文本
                    </van-button>
                  </div>
                  <pre v-if="artifact.previewText" class="wc-code-box">{{ artifact.previewText }}</pre>
                </div>
              </article>
            </div>
          </div>

          <!-- 底部输入栏 -->
          <section class="wc-composer-shell" v-if="showComposer">
            <input
              ref="attachmentInput"
              class="wc-composer-file-input"
              type="file"
              multiple
              @change="onAttachmentInputChange"
            />
            <div v-if="pendingAttachments.length" class="wc-composer-attachments">
              <button
                v-for="attachment in pendingAttachments"
                :key="attachment.clientId"
                type="button"
                class="wc-composer-attachment"
                @click="removePendingAttachment(attachment.clientId)"
              >
                <span class="wc-composer-attachment-name">{{ attachment.name }}</span>
                <span class="wc-composer-attachment-meta">{{ formatBytes(attachment.size) }}</span>
                <span class="wc-composer-attachment-remove">移除</span>
              </button>
            </div>
            <div class="wc-composer-inner">
              <button
                type="button"
                class="wc-composer-tool"
                :disabled="sending"
                @click="triggerAttachmentPicker"
              >
                +
              </button>
              <div class="wc-composer-input">
                <van-field
                  v-model="draftMessage"
                  rows="2"
                  autosize
                  type="textarea"
                  maxlength="12000"
                  placeholder="输入任务描述…"
                  @keydown.enter.exact.prevent="sendMessage"
                />
              </div>
              <button
                class="wc-composer-send"
                :disabled="!currentSessionId || sending || (!draftMessage.trim() && !pendingAttachments.length)"
                @click="sendMessage"
              >
                {{ sending ? '⏳' : '↑' }}
              </button>
            </div>
          </section>
        </main>

        <!-- ===== 移动端底部 Tabbar ===== -->
        <div class="wc-bottom-tabbar wc-mobile-only" v-if="currentSession">
          <van-tabbar v-model="activeTab" :safe-area-inset-bottom="false" :fixed="false">
            <van-tabbar-item name="messages" icon="chat-o">消息</van-tabbar-item>
            <van-tabbar-item name="events" icon="bell">
              事件
              <template v-if="unreadEventCount > 0" #badge>
                {{ unreadEventCount > 99 ? '99+' : unreadEventCount }}
              </template>
            </van-tabbar-item>
            <van-tabbar-item name="artifacts" icon="photo-o">
              产物
              <template v-if="(currentSession?.artifacts || []).length > 0" #badge>
                {{ currentSession.artifacts.length }}
              </template>
            </van-tabbar-item>
          </van-tabbar>
        </div>

        <!-- ===== 移动端侧边栏弹出 ===== -->
        <van-popup
          v-model:show="mobileSidebarVisible"
          position="left"
          :style="{ width: '86vw', height: '100%' }"
          round
          :lazy-render="false"
        >
          <div class="wc-sidebar-sheet">
            <section class="wc-brand-card">
              <p class="wc-eyebrow">Mobile Console</p>
              <h1 class="wc-brand-title">Codex 会话台</h1>
              <p class="wc-brand-copy">切会话、改令牌、看历史。</p>
            </section>
            <section class="wc-sidebar-card">
              <div class="wc-section-head">
                <h2 class="wc-panel-title">访问令牌</h2>
                <div class="wc-section-actions">
                  <van-button size="small" plain round type="primary" @click="toggleTokenEditor">
                    {{ tokenEditorOpen ? '收起' : '更换' }}
                  </van-button>
                  <van-button v-if="tokenEditorOpen" size="small" round type="primary" @click="saveToken">
                    保存
                  </van-button>
                </div>
              </div>
              <p :class="['wc-token-status', tokenStatusOk ? 'wc-token-ok' : 'wc-token-error']">{{ tokenStatusText }}</p>
              <div :class="['wc-token-editor', tokenEditorOpen ? '' : 'collapsed']">
                <van-field
                  v-model="draftToken"
                  type="password"
                  label="令牌"
                  placeholder="请输入访问令牌"
                  autocomplete="off"
                />
              </div>
            </section>
            <section class="wc-sidebar-card">
              <div class="wc-section-head">
                <h2 class="wc-panel-title">推送状态</h2>
                <div class="wc-section-actions">
                  <van-button size="small" plain round :disabled="!token || pushLoading" @click="refreshPushStatus">
                    刷新
                  </van-button>
                </div>
              </div>
              <div v-if="!token" class="wc-empty-box" style="min-height:72px;padding:16px;">
                <span class="wc-empty-text">先填写访问令牌，再查看设备注册状态。</span>
              </div>
              <div v-else class="wc-push-summary">
                <p :class="['wc-token-status', pushSummary?.configured ? 'wc-token-ok' : 'wc-token-error']">
                  {{ pushSummaryText }}
                </p>
                <div class="wc-push-badges" v-if="pushSummary">
                  <span class="wc-mini-badge">{{ pushEnvironmentText }}</span>
                  <span class="wc-mini-badge">已注册 {{ pushSummary.deviceCount || 0 }} 台</span>
                  <span class="wc-mini-badge">启用 {{ pushSummary.enabledDeviceCount || 0 }} 台</span>
                </div>
                <div v-if="pushLoading" class="wc-empty-box" style="min-height:72px;padding:16px;">
                  <span class="wc-empty-text">正在读取推送状态…</span>
                </div>
                <div v-else-if="pushDevices.length" class="wc-push-device-list">
                  <article v-for="device in pushDevices" :key="device.id" class="wc-push-device">
                    <div class="wc-push-device-head">
                      <div class="wc-push-device-meta">
                        <strong class="wc-push-device-title">{{ device.deviceName || '未命名设备' }}</strong>
                        <span class="wc-push-device-token">{{ device.tokenMasked || '无 token' }}</span>
                      </div>
                      <span class="wc-push-device-status" :class="{ disabled: !device.pushEnabled || device.invalidatedAt }">
                        {{ pushDeviceStatusText(device) }}
                      </span>
                    </div>
                    <div class="wc-push-device-actions">
                      <span class="wc-push-device-note">{{ device.bundleId || '未登记 Bundle ID' }}</span>
                      <van-button
                        size="small"
                        round
                        plain
                        type="primary"
                        :loading="pushTestingDeviceId === device.id"
                        @click="sendPushTest(device)"
                      >
                        测试通知
                      </van-button>
                    </div>
                  </article>
                </div>
                <div v-else class="wc-empty-box" style="min-height:72px;padding:16px;">
                  <span class="wc-empty-text">还没有 iOS 设备注册到当前服务。</span>
                </div>
              </div>
            </section>
            <section class="wc-sidebar-card" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
              <div class="wc-section-head">
                <h2 class="wc-panel-title">会话列表</h2>
                <div class="wc-section-actions">
                  <van-button size="small" plain round @click="refreshSessions">刷新</van-button>
                  <van-button size="small" round type="primary" @click="createSession">新建</van-button>
                </div>
              </div>
              <div v-if="!token" class="wc-empty-box" style="min-height:80px;padding:16px;">
                <span class="wc-empty-text">先填写访问令牌。</span>
              </div>
              <div v-else-if="!sessions.length" class="wc-empty-box" style="min-height:80px;padding:16px;">
                <span class="wc-empty-text">还没有可展示的会话。</span>
              </div>
              <div v-else class="wc-session-list" style="flex:1;max-height:none;">
                <button
                  v-for="session in sessions"
                  :key="session.id"
                  class="wc-session-item"
                  :class="{ active: session.id === currentSessionId }"
                  @click="openSession(session.id, true)"
                >
                  <div class="wc-session-item-head">
                    <span class="wc-session-title">{{ session.title || '未命名会话' }}</span>
                    <span class="wc-session-source">{{ sourceLabel(session.source) }}</span>
                  </div>
                  <p class="wc-session-preview">{{ session.preview || '暂无摘要' }}</p>
                  <div class="wc-session-item-foot">
                    <span class="wc-session-foot-item">{{ statusText(session.status) }}</span>
                    <span class="wc-session-foot-item">{{ formatTime(session.updatedAt) }}</span>
                  </div>
                </button>
              </div>
            </section>
          </div>
        </van-popup>

      </div>
    </van-config-provider>
  `,

  data() {
    return {
      token: localStorage.getItem('web_codex_token') || '',
      draftToken: localStorage.getItem('web_codex_token') || '',
      tokenEditorOpen: !localStorage.getItem('web_codex_token'),
      tokenStatusText: localStorage.getItem('web_codex_token') ? '已读取本地令牌。' : '未设置令牌时无法读取接口。',
      tokenStatusOk: Boolean(localStorage.getItem('web_codex_token')),
      sessions: [],
      currentSessionId: '',
      currentSession: null,
      activeTab: 'messages',
      draftMessage: '',
      pendingAttachments: [],
      sending: false,
      sessionLoading: false,
      refreshing: false,
      mobileSidebarVisible: false,
      mobileMenuVisible: false,
      mobileMenuActions: [
        { text: '删除记录', value: 'delete', color: '#d4362c' },
        { text: '刷新会话', value: 'refresh' },
      ],
      streamState: 'idle',
      stream: null,
      streamSessionId: '',
      isMobileView: window.innerWidth < 980,
      isStandaloneApp: false,
      runtimeSafeBottom: 0,
      lastEventCount: 0,
      sessionLoadToken: 0,
      loadingOlderMessages: false,
      suppressNextAutoScroll: false,
      pushSummary: null,
      pushDevices: [],
      pushLoading: false,
      pushTestingDeviceId: '',
    };
  },

  created() {
    this.markdownRenderCache = new Map();
  },

  computed: {
    latestEvents() {
      const events = Array.isArray(this.currentSession?.events) ? this.currentSession.events : [];
      return [...events].reverse().slice(0, 80);
    },
    sessionMessages() {
      return Array.isArray(this.currentSession?.messages) ? this.currentSession.messages : [];
    },
    pushSummaryText() {
      if (!this.pushSummary) {
        return '尚未读取推送服务状态。';
      }
      if (!this.pushSummary.serviceEnabled) {
        return '服务端已关闭推送功能。';
      }
      if (!this.pushSummary.configured) {
        return 'APNs 证书或 Key 尚未配置完整。';
      }
      return 'APNs 已配置，可接收任务完成通知。';
    },
    pushEnvironmentText() {
      if (!this.pushSummary) {
        return '环境未知';
      }
      return this.pushSummary.environment === 'production' ? '生产环境' : '开发环境';
    },
    isRunning() {
      return Boolean(this.currentSession?.canStop);
    },
    sessionMetaText() {
      if (!this.currentSession) {
        return '选择左侧会话后可查看详情。';
      }
      return [
        `状态：${this.statusText(this.currentSession.status)}`,
        this.currentSession.codexThreadId ? `Thread：${this.currentSession.codexThreadId}` : '',
        this.currentSession.model ? `模型：${this.currentSession.model}` : '',
        this.currentSession.reasoningEffort ? `推理：${this.currentSession.reasoningEffort}` : '',
        this.formatContextUsage(this.currentSession.tokenUsage),
        this.currentSession.workdir ? `目录：${this.currentSession.workdir}` : '',
      ].filter(Boolean).join('  |  ');
    },
    unreadEventCount() {
      const total = Array.isArray(this.currentSession?.events) ? this.currentSession.events.length : 0;
      const read = this.lastEventCount;
      return this.activeTab === 'events' ? 0 : Math.max(0, total - read);
    },
    showComposer() {
      return Boolean(this.currentSession) && (!this.isMobileView || this.activeTab === 'messages');
    },
    messageProgressBubble() {
      return this.buildMessageProgressBubble();
    },
    messageScrollKey() {
      const messages = this.sessionMessages;
      const lastMessage = messages[messages.length - 1];
      return [
        this.currentSession?.id || '',
        messages.length,
        lastMessage?.id || '',
        lastMessage?.createdAt || '',
        this.messageProgressBubble?.key || '',
      ].join(':');
    },
  },

  watch: {
    activeTab(tab) {
      if (tab === 'events') {
        this.lastEventCount = Array.isArray(this.currentSession?.events) ? this.currentSession.events.length : 0;
      }
      if (tab === 'messages') {
        this.scrollToBottom();
      }
    },
    messageScrollKey() {
      if (this.suppressNextAutoScroll) {
        this.suppressNextAutoScroll = false;
        return;
      }
      if (!this.sessionLoading) {
        this.scrollToBottom();
      }
    },
  },

  mounted() {
    this.updateDisplayMode();
    this.updateSafeAreaMetrics();
    this.syncThemeColor();
    if (this.token) {
      this.refreshSessions();
      this.refreshPushStatus({ silent: true });
    }
    // 监听窗口尺寸
    window.addEventListener('resize', this.onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.updateSafeAreaMetrics);
      window.visualViewport.addEventListener('scroll', this.updateSafeAreaMetrics);
    }
  },

  beforeUnmount() {
      this.closeStream();
      this.streamState = 'idle';
      document.body.classList.remove('wc-body-standalone');
      window.removeEventListener('resize', this.onResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this.updateSafeAreaMetrics);
        window.visualViewport.removeEventListener('scroll', this.updateSafeAreaMetrics);
      }
    },

  methods: {
    onResize() {
      this.isMobileView = window.innerWidth < 980;
      this.updateDisplayMode();
      this.updateSafeAreaMetrics();
      this.syncThemeColor();
    },

    updateDisplayMode() {
      const mediaMatched = typeof window.matchMedia === 'function'
        && window.matchMedia('(display-mode: standalone)').matches;
      const iosStandalone = Boolean(window.navigator && window.navigator.standalone);
      this.isStandaloneApp = mediaMatched || iosStandalone;
      document.body.classList.toggle('wc-body-standalone', this.isStandaloneApp);
    },

    updateSafeAreaMetrics() {
      const viewport = window.visualViewport;
      const innerHeight = window.innerHeight || 0;
      let bottomInset = 0;

      if (viewport) {
        const viewportBottom = viewport.height + viewport.offsetTop;
        bottomInset = Math.max(0, Math.round(innerHeight - viewportBottom));
      }

      if (this.isStandaloneApp && bottomInset < 12) {
        bottomInset = 12;
      }

      this.runtimeSafeBottom = bottomInset;
      document.documentElement.style.setProperty('--wc-runtime-safe-bottom', `${bottomInset}px`);
    },

    syncThemeColor() {
      const rootStyle = window.getComputedStyle(document.documentElement);
      const themeColor = String(rootStyle.getPropertyValue('--wc-card-strong') || '').trim() || '#fffdfa';
      let meta = document.querySelector('meta[name="theme-color"]:not([media])');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', themeColor);
    },

    renderMarkdown(text) {
      if (!text) return '';
      if (typeof marked !== 'undefined' && marked.parse) {
        try {
          return marked.parse(text, { breaks: true, gfm: true });
        } catch { return text; }
      }
      // marked 未加载时降级为纯文本
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    },

    messageHtml(message) {
      const id = String(message?.id || '');
      const text = String(message?.text || '');
      const cacheKey = `${id}:${text}`;
      const cached = this.markdownRenderCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const html = this.renderMarkdown(text);
      this.markdownRenderCache.set(cacheKey, html);

      if (this.markdownRenderCache.size > 800) {
        const keys = this.markdownRenderCache.keys();
        for (let index = 0; index < 200; index += 1) {
          const next = keys.next();
          if (next.done) {
            break;
          }
          this.markdownRenderCache.delete(next.value);
        }
      }

      return html;
    },

    async scrollToBottom() {
      if (this.sessionLoading || this.activeTab !== 'messages') return;
      await nextTick();
      const scroll = () => {
        const chatArea = this.$refs.chatArea;
        const messageBottom = this.$refs.messageBottom;
        if (messageBottom && typeof messageBottom.scrollIntoView === 'function') {
          messageBottom.scrollIntoView({
            block: 'end',
            inline: 'nearest',
          });
        }
        if (chatArea) {
          chatArea.scrollTop = chatArea.scrollHeight;
        }
      };
      // 多次滚动：nextTick 后立即一次，再用递增延时补刷，
      // 确保 v-show 切换 + DOM 渲染 + 图片加载等异步完成后都能到底
      scroll();
      setTimeout(scroll, 50);
      setTimeout(scroll, 150);
      setTimeout(scroll, 400);
    },

    async onPullRefresh() {
      if (this.currentSessionId) {
        await this.loadSession(this.currentSessionId, { keepStream: true });
      }
      this.refreshing = false;
    },

    onMobileMenuSelect(action) {
      this.mobileMenuVisible = false;
      if (action.value === 'delete') {
        this.deleteSession();
      } else if (action.value === 'refresh') {
        this.refreshSessions();
      }
    },

    toggleTokenEditor() {
      this.tokenEditorOpen = !this.tokenEditorOpen;
    },

    async saveToken() {
      const token = String(this.draftToken || '').trim();
      if (!token) {
        this.setTokenStatus('请先输入访问令牌。', false);
        showFailToast('请先输入访问令牌');
        return;
      }

      this.token = token;
      this.draftToken = token;
      localStorage.setItem('web_codex_token', token);
      this.tokenEditorOpen = false;
      this.closeStream();
      this.currentSession = null;
      this.currentSessionId = '';
      this.setTokenStatus('令牌已保存，正在刷新会话列表。', true);
      showSuccessToast('令牌已保存');
      await this.refreshSessions();
      await this.refreshPushStatus({ silent: true });
    },

    async refreshPushStatus(options = {}) {
      if (!this.token) {
        this.pushSummary = null;
        this.pushDevices = [];
        return;
      }

      this.pushLoading = true;
      try {
        const data = await this.requestJson('/api/push/devices');
        this.pushSummary = data.push || null;
        this.pushDevices = Array.isArray(data.devices) ? data.devices : [];
      } catch (error) {
        this.pushSummary = null;
        this.pushDevices = [];
        if (!options.silent) {
          const message = error instanceof Error ? error.message : String(error);
          showFailToast({
            message,
            duration: 2200,
          });
        }
      } finally {
        this.pushLoading = false;
      }
    },

    async sendPushTest(device) {
      if (!device?.id) {
        return;
      }

      this.pushTestingDeviceId = device.id;
      try {
        const data = await this.requestJson('/api/push/test', {
          method: 'POST',
          body: JSON.stringify({
            id: device.id,
            title: '测试通知',
            subtitle: 'Codex 会话台',
            body: '如果你看到这条通知，说明 APNs 到设备链路已经打通。',
          }),
        });
        if (!data?.ok) {
          throw new Error(data?.result?.reason || '测试通知发送失败');
        }
        showSuccessToast('测试通知已发送');
        await this.refreshPushStatus({ silent: true });
      } catch (error) {
        this.reportUiError(error);
      } finally {
        this.pushTestingDeviceId = '';
      }
    },

    pushDeviceStatusText(device) {
      if (device?.invalidatedAt) {
        return '已失效';
      }
      if (!device?.pushEnabled) {
        return '已关闭';
      }
      return '已启用';
    },

    upsertSessionSummary(session, options = {}) {
      if (!session?.id) {
        return;
      }

      const summary = {
        id: session.id,
        title: session.title || '未命名会话',
        source: session.source || 'web',
        status: session.status || 'idle',
        preview: session.preview || '',
        updatedAt: session.updatedAt || new Date().toISOString(),
        createdAt: session.createdAt || session.updatedAt || new Date().toISOString(),
        lastActivityAt: session.lastActivityAt || session.updatedAt || new Date().toISOString(),
        workdir: session.workdir || '',
        codexThreadId: session.codexThreadId || session.id,
        lastError: session.lastError || '',
      };

      const sessions = Array.isArray(this.sessions) ? [...this.sessions] : [];
      const index = sessions.findIndex((item) => item.id === summary.id);
      if (index >= 0) {
        sessions.splice(index, 1, {
          ...sessions[index],
          ...summary,
        });
      } else if (options.prepend) {
        sessions.unshift(summary);
      } else {
        sessions.push(summary);
      }

      sessions.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      this.sessions = sessions;
    },

    async refreshSessions(preferredSessionId = '') {
      if (!this.token) {
        this.sessions = [];
        this.pushSummary = null;
        this.pushDevices = [];
        return;
      }

      try {
        const data = await this.requestJson('/api/sessions');
        this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const preferredId = String(preferredSessionId || this.currentSessionId || '').trim();

        if (!this.sessions.length) {
          this.currentSessionId = '';
        this.currentSession = null;
        this.closeStream();
        this.streamState = 'idle';
        this.setTokenStatus('暂无会话，可先新建。', true);
        return;
        }

        const nextSessionId = preferredId && this.sessions.some((item) => item.id === preferredId)
          ? preferredId
          : (this.currentSessionId && this.sessions.some((item) => item.id === this.currentSessionId)
            ? this.currentSessionId
            : this.sessions[0].id);

        if (!nextSessionId) {
          return;
        }

        this.currentSessionId = nextSessionId;
        await this.loadSession(nextSessionId, {
          keepStream: this.streamSessionId === nextSessionId,
        });
        this.setTokenStatus('接口可用，会话列表已刷新。', true);
      } catch (error) {
        this.sessions = [];
        this.reportUiError(error);
      }
    },

    async createSession() {
      try {
        const data = await this.requestJson('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        this.currentSessionId = data.session.id;
        this.currentSession = data.session;
        this.lastEventCount = Array.isArray(data.session?.events) ? data.session.events.length : 0;
        this.upsertSessionSummary(data.session, { prepend: true });
        await this.refreshSessions(data.session.id);
        this.mobileSidebarVisible = false;
      } catch (error) {
        this.reportUiError(error);
      }
    },

    async openSession(sessionId, closeSidebar = false) {
      try {
        await this.loadSession(sessionId);
        if (closeSidebar) {
          this.mobileSidebarVisible = false;
        }
      } catch (error) {
        this.reportUiError(error);
      }
    },

    async loadSession(sessionId, options = {}) {
      if (!sessionId) {
        this.currentSession = null;
        return;
      }

      const keepStream = Boolean(options.keepStream);
      const token = ++this.sessionLoadToken;
      this.sessionLoading = true;

      try {
        const data = await this.requestJson(`/api/sessions/${encodeURIComponent(sessionId)}?messageLimit=${MESSAGE_PAGE_SIZE}`);
        if (token !== this.sessionLoadToken) {
          return;
        }
        this.currentSessionId = sessionId;
        this.currentSession = {
          ...data.session,
          messagePage: data.session?.messagePage || {
            hasMore: false,
            nextBeforeId: '',
            loaded: Array.isArray(data.session?.messages) ? data.session.messages.length : 0,
            limit: MESSAGE_PAGE_SIZE,
          },
        };
        this.lastEventCount = Array.isArray(data.session?.events) ? data.session.events.length : 0;

        if (!keepStream) {
          this.connectStream(sessionId);
        }

      } finally {
        if (token === this.sessionLoadToken) {
          this.sessionLoading = false;
          this.scrollToBottom();
        }
      }
    },

    async loadOlderMessages() {
      if (
        this.sessionLoading
        || this.loadingOlderMessages
        || !this.currentSessionId
        || !this.currentSession?.messagePage?.hasMore
      ) {
        return;
      }

      const beforeId = String(
        this.currentSession?.messagePage?.nextBeforeId
        || this.sessionMessages[0]?.id
        || ''
      ).trim();
      if (!beforeId) {
        return;
      }

      const chatArea = this.$refs.chatArea;
      const previousHeight = chatArea?.scrollHeight || 0;
      const previousTop = chatArea?.scrollTop || 0;
      this.loadingOlderMessages = true;

      try {
        const data = await this.requestJson(
          `/api/sessions/${encodeURIComponent(this.currentSessionId)}/messages?before=${encodeURIComponent(beforeId)}&limit=${MESSAGE_PAGE_SIZE}`
        );
        if (!this.currentSession || this.currentSession.id !== this.currentSessionId) {
          return;
        }

        const olderMessages = Array.isArray(data.messages) ? data.messages : [];
        const currentMessages = Array.isArray(this.currentSession.messages) ? this.currentSession.messages : [];
        const existingIds = new Set(currentMessages.map((message) => String(message?.id || '')));
        const prependMessages = olderMessages.filter((message) => !existingIds.has(String(message?.id || '')));

        this.currentSession.messagePage = data.page || this.currentSession.messagePage;
        if (!prependMessages.length) {
          return;
        }

        this.suppressNextAutoScroll = true;
        this.currentSession.messages = prependMessages.concat(currentMessages);
        await nextTick();

        if (chatArea) {
          const nextHeight = chatArea.scrollHeight;
          chatArea.scrollTop = Math.max(0, nextHeight - previousHeight + previousTop);
        }
      } finally {
        this.loadingOlderMessages = false;
      }
    },

    handleMessageScroll() {
      if (this.activeTab !== 'messages') {
        return;
      }

      const chatArea = this.$refs.chatArea;
      if (!chatArea || chatArea.scrollTop > MESSAGE_TOP_LOAD_THRESHOLD) {
        return;
      }

      this.loadOlderMessages();
    },

    async sendMessage() {
      if (!this.currentSessionId) {
        this.reportUiError(new Error('请先选择或创建会话。'));
        return;
      }

      const message = String(this.draftMessage || '').trim();
      const attachments = Array.isArray(this.pendingAttachments) ? [...this.pendingAttachments] : [];
      if (!message && !attachments.length) {
        return;
      }

      const draft = message;
      const draftAttachments = attachments;
      this.sending = true;
      this.draftMessage = '';
      this.pendingAttachments = [];

      try {
        await this.requestJson(`/api/sessions/${encodeURIComponent(this.currentSessionId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            message,
            attachments: attachments.map((item) => ({
              name: item.name,
              size: item.size,
              mimeType: item.mimeType,
              kind: item.kind,
              dataBase64: item.dataBase64,
            })),
          }),
        });
        this.activeTab = 'messages';
        await this.loadSession(this.currentSessionId, { keepStream: true });
        this.scrollToBottom();
      } catch (error) {
        this.draftMessage = draft;
        this.pendingAttachments = draftAttachments;
        this.reportUiError(error);
      } finally {
        this.sending = false;
      }
    },

    triggerAttachmentPicker() {
      this.$refs.attachmentInput?.click?.();
    },

    async onAttachmentInputChange(event) {
      const input = event?.target;
      const files = Array.from(input?.files || []);
      if (input) {
        input.value = '';
      }
      if (!files.length) {
        return;
      }

      try {
        await this.addPendingAttachments(files);
      } catch (error) {
        this.reportUiError(error);
      }
    },

    async addPendingAttachments(files) {
      const current = Array.isArray(this.pendingAttachments) ? [...this.pendingAttachments] : [];
      const currentBytes = current.reduce((sum, item) => sum + Number(item.size || 0), 0);
      let totalBytes = currentBytes;

      for (const file of files) {
        if (current.length >= 6) {
          throw new Error('最多只能添加 6 个附件');
        }

        if (current.some((item) => item.name === file.name && item.size === file.size)) {
          continue;
        }

        totalBytes += Number(file.size || 0);
        if (totalBytes > 10 * 1024 * 1024) {
          throw new Error('附件总体积不能超过 10MB');
        }

        current.push({
          clientId: makeClientId('att'),
          name: file.name,
          size: Number(file.size || 0),
          mimeType: file.type || 'application/octet-stream',
          kind: this.inferAttachmentKind(file.name, file.type),
          dataBase64: await this.readFileAsDataUrl(file),
        });
      }

      this.pendingAttachments = current;
    },

    removePendingAttachment(clientId) {
      this.pendingAttachments = (Array.isArray(this.pendingAttachments) ? this.pendingAttachments : [])
        .filter((item) => item.clientId !== clientId);
    },

    readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`读取附件失败：${file?.name || '未知文件'}`));
        reader.readAsDataURL(file);
      });
    },

    inferAttachmentKind(name, mimeType) {
      const normalizedMime = String(mimeType || '').toLowerCase();
      const normalizedName = String(name || '').toLowerCase();
      if (normalizedMime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(normalizedName)) {
        return 'image';
      }
      if (normalizedMime.startsWith('text/') || /\.(txt|md|json|log|csv|html)$/.test(normalizedName)) {
        return 'text';
      }
      if (/\.(zip)$/.test(normalizedName)) {
        return 'archive';
      }
      if (/\.(pdf|docx?|xlsx?|pptx?)$/.test(normalizedName)) {
        return 'document';
      }
      return 'file';
    },

    async stopSession() {
      if (!this.currentSessionId) {
        return;
      }

      try {
        await this.requestJson(`/api/sessions/${encodeURIComponent(this.currentSessionId)}/stop`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        showSuccessToast('已发送停止请求');
      } catch (error) {
        this.reportUiError(error);
      }
    },

    async deleteSession() {
      if (!this.currentSessionId || this.isRunning) {
        return;
      }

      try {
        await showConfirmDialog({
          title: '删除本地记录',
          message: '只会删除本地 Web 记录，不会删除 Codex 原始历史。',
          confirmButtonText: '删除',
          cancelButtonText: '取消',
        });
      } catch {
        return;
      }

      try {
        await this.requestJson(`/api/sessions/${encodeURIComponent(this.currentSessionId)}`, {
          method: 'DELETE',
        });
        this.closeStream();
        this.currentSession = null;
        this.currentSessionId = '';
        showSuccessToast('已删除');
        await this.refreshSessions();
      } catch (error) {
        this.reportUiError(error);
      }
    },

    connectStream(sessionId) {
      this.closeStream();
      if (!this.token || !sessionId) {
        return;
      }

      this.streamState = 'connecting';
      const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream?token=${encodeURIComponent(this.token)}`);
      this.stream = source;
      this.streamSessionId = sessionId;

      source.onopen = () => {
        if (this.stream !== source) {
          return;
        }
        this.streamState = 'online';
      };

      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.applyStreamEvent(payload);
        } catch {}
      };

      source.onerror = () => {
        if (this.stream !== source) {
          return;
        }
        this.streamState = 'reconnecting';
      };
    },

    closeStream() {
      if (this.stream) {
        this.stream.close();
        this.stream = null;
        this.streamSessionId = '';
      }
      this.streamState = 'idle';
    },

    applyStreamEvent(event) {
      if (!this.currentSession || event.sessionId !== this.currentSession.id) {
        return;
      }

      const events = Array.isArray(this.currentSession.events) ? this.currentSession.events : [];
      events.push(event);
      if (events.length > 240) {
        events.splice(0, events.length - 240);
      }
      this.currentSession.events = events;

      if (event.type === 'status') {
        this.currentSession.status = this.inferStatusFromEvent(event.payload?.text, this.currentSession.status);
        this.currentSession.canStop = this.currentSession.status === 'running';
        if (event.payload?.model) {
          this.currentSession.model = event.payload.model;
        }
      }

      if (event.type === 'message' && event.payload?.text) {
        const messages = Array.isArray(this.currentSession.messages) ? this.currentSession.messages : [];
        messages.push({
          id: makeClientId('msg'),
          role: event.payload.role || 'assistant',
          text: event.payload.text,
          createdAt: event.timestamp,
          source: 'web',
        });
        this.currentSession.messages = messages;
        if (this.currentSession.messagePage) {
          this.currentSession.messagePage = {
            ...this.currentSession.messagePage,
            loaded: messages.length,
          };
        }
        this.currentSession.lastReply = event.payload.text;
        this.currentSession.status = this.currentSession.canStop ? 'running' : this.currentSession.status;
        this.activeTab = 'messages';
        this.scrollToBottom();
      }

      if (event.type === 'artifact' && event.payload?.artifact) {
        const artifacts = Array.isArray(this.currentSession.artifacts) ? this.currentSession.artifacts : [];
        if (!artifacts.some((item) => item.id === event.payload.artifact.id)) {
          artifacts.push(event.payload.artifact);
        }
        this.currentSession.artifacts = artifacts;
      }

      if (event.type === 'error') {
        this.currentSession.lastError = event.payload?.message || '发生错误';
        this.currentSession.status = 'error';
        this.currentSession.canStop = false;
      }

      if (event.type === 'done') {
        this.currentSession.status = event.payload?.status === 'stopped'
          ? 'stopped'
          : event.payload?.status === 'error'
            ? 'error'
            : 'idle';
        this.currentSession.canStop = false;
        const nextSessionId = String(event.payload?.sessionId || '').trim();
        if (nextSessionId && nextSessionId !== this.currentSessionId) {
          this.currentSessionId = nextSessionId;
          this.closeStream();
          this.loadSession(nextSessionId).catch((error) => {
            this.reportUiError(error);
          });
          return;
        }
        this.refreshSessions();
      }
    },

    async loadTextPreview(artifact) {
      try {
        const data = await this.requestJson(`/api/files/${encodeURIComponent(artifact.id)}?preview=1`);
        artifact.previewText = data.text;
        this.activeTab = 'artifacts';
      } catch (error) {
        this.reportUiError(error);
      }
    },

    previewImage(artifact) {
      ImagePreview({
        images: [this.fileUrl(artifact.id)],
        startPosition: 0,
        closeable: true,
      });
    },

    openArtifact(artifact) {
      const url = this.fileUrl(artifact.id);
      window.open(url, '_blank', 'noopener');
    },

    openMessageAttachment(attachment) {
      if (!attachment?.id) {
        return;
      }

      if (attachment.kind === 'image') {
        this.previewImage(attachment);
        return;
      }

      this.openArtifact(attachment);
    },

    async requestJson(pathname, options = {}) {
      if (!this.token) {
        throw new Error('请先输入访问令牌。');
      }

      const response = await fetch(pathname, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': this.token,
          ...(options.headers || {}),
        },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `请求失败：${response.status}`);
      }
      return data;
    },

    setTokenStatus(text, ok) {
      this.tokenStatusText = text;
      this.tokenStatusOk = Boolean(ok);
    },

    reportUiError(error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setTokenStatus(message, false);
      showFailToast({
        message,
        duration: 2200,
      });
    },

    sourceLabel(source) {
      if (source === 'codex') return '原生历史';
      if (source === 'imported') return '已导入';
      return '本地';
    },

    statusText(status) {
      if (status === 'running') return '执行中';
      if (status === 'error') return '失败';
      if (status === 'stopped') return '已停止';
      return '空闲';
    },

    statusClass(status) {
      if (status === 'running') return 'running';
      if (status === 'error') return 'error';
      if (status === 'stopped') return 'stopped';
      return 'idle';
    },

    eventTypeLabel(type) {
      if (type === 'message') return '回复';
      if (type === 'artifact') return '产物';
      if (type === 'error') return '异常';
      if (type === 'done') return '结束';
      return '状态';
    },

    eventBodyText(event) {
      if (event.type === 'message') return event.payload?.text || '';
      if (event.type === 'artifact') return event.payload?.artifact?.name || '已登记产物';
      if (event.type === 'error') return event.payload?.message || '发生错误';
      if (event.type === 'done') return `本轮完成：${event.payload?.status || 'done'}`;
      return this.describeStatusEvent(event.payload?.text);
    },

    artifactKindLabel(kind) {
      if (kind === 'image') return '图片';
      if (kind === 'text') return '文本';
      if (kind === 'archive') return '压缩包';
      if (kind === 'document') return '文档';
      return '文件';
    },

    formatContextUsage(tokenUsage) {
      if (!tokenUsage || typeof tokenUsage !== 'object') {
        return '';
      }

      const contextTokens = Number(tokenUsage.contextTokens ?? 0);
      const contextWindow = Number(tokenUsage.modelContextWindow ?? 0);
      const remainingTokens = Number(tokenUsage.remainingTokens ?? 0);
      const cumulativeTokens = Number(tokenUsage.total?.totalTokens ?? 0);
      const lastTurnTokens = Number(tokenUsage.last?.totalTokens ?? 0);
      const percent = Number.isFinite(Number(tokenUsage.contextUsagePercent))
        ? Number(tokenUsage.contextUsagePercent)
        : (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : NaN);

      const parts = [];
      if (contextTokens > 0 && contextWindow > 0 && contextTokens <= contextWindow) {
        parts.push(`上下文：${this.formatNumber(contextTokens)} / ${this.formatNumber(contextWindow)}（${this.formatPercent(percent)}）`);
      } else {
        if (contextWindow > 0) {
          parts.push(`窗口：${this.formatNumber(contextWindow)}`);
        }
      }
      if (cumulativeTokens > 0) {
        parts.push(`累计：${this.formatNumber(cumulativeTokens)}`);
      }
      if (remainingTokens > 0 && contextWindow > 0 && contextTokens <= contextWindow) {
        parts.push(`剩余：${this.formatNumber(remainingTokens)}`);
      }
      if (lastTurnTokens > 0) {
        parts.push(`本轮：${this.formatNumber(lastTurnTokens)}`);
      }

      return parts.join(' · ');
    },

    fileUrl(artifactId) {
      return `/api/files/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(this.token)}`;
    },

    inferStatusFromEvent(text, fallback) {
      const normalized = String(text || '');
      if (normalized.includes('停止')) return 'stopped';
      if (normalized.includes('失败') || normalized.includes('异常') || normalized.includes('超时')) return 'error';
      if (normalized) return 'running';
      return fallback || 'idle';
    },

    latestProgressEvent() {
      const events = Array.isArray(this.currentSession?.events) ? this.currentSession.events : [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'status' || event?.type === 'error' || event?.type === 'done') {
          return event;
        }
      }
      return null;
    },

    buildMessageProgressBubble() {
      const session = this.currentSession;
      if (!session) {
        return null;
      }

      if (this.streamState === 'reconnecting' && session.status === 'running') {
        return {
          key: 'stream-reconnecting',
          tone: 'connect',
          icon: '·',
          stage: '连接',
          title: '实时连接暂时中断',
          detail: '页面保持打开，浏览器会自动重连并继续接收进度。',
          loading: true,
          timeText: '刚刚',
        };
      }

      if (session.status === 'error') {
        return {
          key: `error:${session.lastError || ''}`,
          tone: 'error',
          icon: '!',
          stage: '异常',
          title: '任务执行出错',
          detail: this.limitStatusDetail(session.lastError || '请切到事件面板查看详细错误。'),
          loading: false,
          timeText: this.formatTime(session.lastActivityAt || session.updatedAt),
        };
      }

      if (session.status === 'stopped') {
        return {
          key: `stopped:${session.lastActivityAt || session.updatedAt || ''}`,
          tone: 'stopped',
          icon: '■',
          stage: '停止',
          title: '任务已停止',
          detail: '当前轮次已经结束，可以继续发送下一条消息。',
          loading: false,
          timeText: this.formatTime(session.lastActivityAt || session.updatedAt),
        };
      }

      if (session.status !== 'running') {
        return null;
      }

      const event = this.latestProgressEvent();
      if (!event) {
        return {
          key: 'running:default',
          tone: 'thinking',
          icon: '…',
          stage: '处理中',
          title: '正在处理中',
          detail: '正在分析任务并准备下一步。',
          loading: true,
          timeText: '刚刚',
        };
      }

      return this.buildStatusBubbleFromEvent(event);
    },

    buildStatusBubbleFromEvent(event) {
      if (!event) {
        return null;
      }

      if (event.type === 'error') {
        return {
          key: `error:${event.timestamp || ''}:${event.payload?.message || ''}`,
          tone: 'error',
          icon: '!',
          stage: '异常',
          title: '任务执行出错',
          detail: this.limitStatusDetail(event.payload?.message || '请查看事件详情。'),
          loading: false,
          timeText: this.formatTime(event.timestamp),
        };
      }

      const normalized = this.parseStatusPresentation(event.payload?.text);
      return {
        key: `status:${normalized.stage}:${normalized.title}:${normalized.detail}:${event.timestamp || ''}`,
        tone: normalized.tone,
        icon: normalized.icon,
        stage: normalized.stage,
        title: normalized.title,
        detail: normalized.detail,
        loading: normalized.loading,
        timeText: this.formatTime(event.timestamp),
      };
    },

    parseStatusPresentation(text) {
      const normalized = String(text || '').trim();
      if (!normalized) {
        return {
          tone: 'thinking',
          icon: '…',
          stage: '处理中',
          title: '正在处理中',
          detail: '正在等待新的执行进度。',
          loading: true,
        };
      }

      if (normalized.startsWith('已提交到 Codex')) {
        return {
          tone: 'connect',
          icon: '↗',
          stage: '提交',
          title: '任务已提交',
          detail: normalized.includes('resume') ? '正在恢复到原生会话并准备执行。' : '正在创建新的 Codex 会话。',
          loading: true,
        };
      }

      if (normalized.startsWith('已连接 Codex')) {
        return {
          tone: 'connect',
          icon: '◎',
          stage: '模型',
          title: '已连接 Codex',
          detail: this.extractModelLabel(normalized),
          loading: true,
        };
      }

      if (normalized === '已创建会话') {
        return {
          tone: 'connect',
          icon: '○',
          stage: '会话',
          title: '会话已建立',
          detail: '正在同步上下文并准备处理任务。',
          loading: true,
        };
      }

      if (normalized === '开始处理') {
        return {
          tone: 'thinking',
          icon: '…',
          stage: '分析',
          title: '开始处理任务',
          detail: '正在整理上下文、计划步骤。',
          loading: true,
        };
      }

      if (normalized.startsWith('执行命令：')) {
        return {
          tone: 'command',
          icon: '>',
          stage: '命令',
          title: '正在执行命令',
          detail: this.summarizeCommandStatus(normalized),
          loading: true,
        };
      }

      if (normalized.startsWith('命令执行完成')) {
        return {
          tone: 'command',
          icon: '✓',
          stage: '命令',
          title: '命令已执行完成',
          detail: this.summarizeCommandCompletion(normalized),
          loading: true,
        };
      }

      if (normalized === '正在整理回复') {
        return {
          tone: 'reply',
          icon: '✦',
          stage: '回复',
          title: '正在整理回复',
          detail: '正在把结果组织成可展示的消息。',
          loading: true,
        };
      }

      if (normalized === '正在停止任务') {
        return {
          tone: 'stopped',
          icon: '■',
          stage: '停止',
          title: '正在停止任务',
          detail: '等待当前步骤安全结束。',
          loading: true,
        };
      }

      if (normalized.includes('任务已超时停止')) {
        return {
          tone: 'stopped',
          icon: '■',
          stage: '超时',
          title: '任务已超时停止',
          detail: '当前轮次因超时结束，可以重新发送消息继续。',
          loading: false,
        };
      }

      if (normalized.includes('任务已停止')) {
        return {
          tone: 'stopped',
          icon: '■',
          stage: '停止',
          title: '任务已停止',
          detail: '当前轮次已经结束。',
          loading: false,
        };
      }

      return {
        tone: 'thinking',
        icon: '…',
        stage: '状态',
        title: this.limitStatusDetail(normalized, 30),
        detail: '',
        loading: true,
      };
    },

    describeStatusEvent(text) {
      const presentation = this.parseStatusPresentation(text);
      return presentation.detail
        ? `${presentation.title} · ${presentation.detail}`
        : presentation.title;
    },

    extractModelLabel(text) {
      const match = String(text || '').match(/已连接 Codex（(.+?)）/);
      return match?.[1] ? `模型：${match[1]}` : '模型连接正常，正在准备执行。';
    },

    summarizeCommandStatus(text) {
      const commandText = String(text || '').replace(/^执行命令：/, '').trim();
      return this.describeCommand(commandText);
    },

    summarizeCommandCompletion(text) {
      const exitMatch = String(text || '').match(/exit=([^)）]+)/);
      const commandText = String(text || '').replace(/^命令执行完成(?:（[^）]+）|\([^)]+\))?：/, '').trim();
      const commandLabel = this.describeCommand(commandText);
      return exitMatch?.[1] ? `${commandLabel} · exit ${exitMatch[1]}` : commandLabel;
    },

    describeCommand(commandText) {
      const primaryToken = getCommandPrimaryToken(commandText);
      const args = splitCommandArguments(commandText);
      const argCount = Math.max(0, args.length - 1);
      const label = this.humanizeCommandToken(primaryToken);

      if (!label) {
        return '正在运行系统命令';
      }

      return argCount > 0 ? `${label} · ${argCount} 个参数` : label;
    },

    humanizeCommandToken(token) {
      const normalized = String(token || '').trim();
      if (!normalized) {
        return '';
      }

      const fileName = normalized
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop()
        .replace(/\.(cmd|exe|ps1|bat|sh)$/i, '')
        .toLowerCase();

      const displayMap = {
        powershell: 'PowerShell',
        pwsh: 'PowerShell',
        node: 'Node.js',
        npm: 'npm',
        pnpm: 'pnpm',
        yarn: 'yarn',
        git: 'Git',
        rg: 'rg 搜索',
        grep: 'grep 搜索',
        python: 'Python',
        python3: 'Python',
        bash: 'Bash',
        sh: 'Shell',
        cmd: '命令行',
      };

      return displayMap[fileName] || fileName || normalized;
    },

    limitStatusDetail(text, maxLength = 72) {
      const normalized = String(text || '').replace(/\s+/g, ' ').trim();
      if (normalized.length <= maxLength) {
        return normalized;
      }
      return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
    },

    formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;

      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const isYesterday = date.toDateString() === yesterday.toDateString();

      const timeStr = new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);

      if (isToday) return timeStr;
      if (isYesterday) return `昨天 ${timeStr}`;

      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    },

    formatBytes(value) {
      const size = Number(value || 0);
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    },

    formatNumber(value) {
      const normalized = Number(value || 0);
      return new Intl.NumberFormat('zh-CN').format(normalized);
    },

    formatPercent(value) {
      const normalized = Number(value);
      if (!Number.isFinite(normalized)) {
        return '0.0%';
      }
      return `${normalized >= 100 ? normalized.toFixed(0) : normalized.toFixed(1)}%`;
    },
  },
}).use(vant).mount('#app');
