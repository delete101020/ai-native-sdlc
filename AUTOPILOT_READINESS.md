# Autopilot — đánh giá mức sẵn sàng

> Trạng thái: **đã chốt toàn bộ quyết định** (mục 6), chưa có thay đổi code nào.
> Viết ngày 2026-10-17, dựa trên `main` tại `e1ef255`.

## 0. Tóm tắt

Repo **đã có** động cơ autopilot: `runExecLoop` trong
`packages/core/src/runs/execEngine.ts`, dùng chung cho `aidlc run exec` (CLI) và
**Run to completion** (extension). Nó chạy được một epic từ đầu đến cuối, nhưng
chỉ theo hai kiểu:

- **dừng** ở mọi cổng cần người (mặc định), hoặc
- **duyệt mù** mọi cổng (`--auto-approve`).

Thứ còn thiếu là một **vòng tự sửa có kiểm soát**: verify/review đọc được kết
quả, trả việc về `implement` kèm lý do, `implement` nhận được lý do đó, và vòng
lặp có trần. Bảy khoảng trống, xếp theo mức nghiêm trọng:

| # | Khoảng trống | Hậu quả nếu bật autopilot hôm nay | Công | Phụ thuộc |
|---|---|---|---|---|
| G1 | Không ai đọc verdict của verify/review | Review kết luận **hold** vẫn được approve | S–M | — |
| G2 | Reject không trả việc về step trước | Loop dừng ở `rejected`, không tự sửa | M | G1 |
| G3 | Feedback không tới agent khi chạy headless | `implement` rev2 sửa mù, không biết vì sao bị trả về | S | — |
| G4 | Không có trần số vòng | Khi có G2: `implement ↔ review` lặp đến khi hết tiền | S | đi cùng G2 |
| G5 | Quyền tool khi chạy headless không cấu hình được | Agent không sửa được code, hoặc có toàn quyền mà không có gate | M | — |
| G6 | Chưa có recipe/preset dành cho autopilot | Người dùng phải tự ghép G1–G5 | S | G1–G5, G7 |
| G7 | `implement` chạy cả plan trong một phiên | Ngữ cảnh loãng, timeout R1 vô nghĩa với plan lớn | M | G4, R1 |

**Đề xuất thứ tự:** G3 → G1 → G2 + G4 (cùng một PR) → G5 → G7 → G6.
G3 và G1 có giá trị ngay cả khi chưa bật autopilot (xem từng mục).

---

## 1. Autopilot nghĩa là gì ở đây

Đề xuất định nghĩa, để có tiêu chí "xong":

> Sau khi con người duyệt các bước **định hướng** (`intent`, `build-plan`, và
> `spec` nếu recipe có), hệ thống tự chạy `implement → verify → review` trên
> **một nhánh riêng**. Khi verify/review phát hiện lỗi, nó **tự trả việc về
> `implement` kèm lý do**, `implement` sửa, và hai bước sau chấm lại. Vòng lặp
> dừng khi:
> (a) review **ship** → con người Approve trong AIDLC rồi merge PR;
> (b) chạm `max_send_backs` (mặc định 3) hoặc `implement` không đổi code → con
> người nhận một run đang dừng, lịch sử ghi rõ đã thử gì và chạm trần nào;
> (c) verdict đề xuất quay về bước định hướng (vd. `spec`) → dừng cho người
> quyết.

Không thuộc phạm vi: tự merge, tự deploy, tự mở epic `maintain`.

**Quyết định (D0):** ✅ **Chốt: đồng ý** định nghĩa trên; con người vẫn là
người merge.

---

## 2. Hiện trạng: những gì đã có

### 2.1 Vòng lặp exec

```
loop:
  cancel?                      → cancelled
  run completed / failed       → completed / error
  step = state.steps[cursor]
  awaiting_auto_review         → chạy validator JS → submitAutoReviewVerdict → continue
  awaiting_review              → --auto-approve ? approve, continue : DỪNG (exit 2)
  rejected                     → optional / on_failure: continue ? bỏ qua : DỪNG (exit 2)
  awaiting_work                → execStep (spawn claude --print) → markStepDone
                               → budget guard → --until → continue
```

### 2.2 Các cơ chế đã sẵn sàng

| Cơ chế | Ở đâu | Ghi chú |
|---|---|---|
| Chạy step headless | `execEngine.ts` `execStep` → `DefaultRunner` (`claude --print --output-format stream-json`) | Mỗi step là một tiến trình mới, nên verify/review **tự nhiên có context sạch**, đúng yêu cầu playbook |
| Phát hiện "báo xong nhưng không ghi gì" | `producesSnapshot.ts` | So fingerprint trước/sau. Tránh lỗi rev2 dùng lại artifact của rev1 |
| Validator JS | `AutoReviewer.ts` | Có timeout (mặc định 120s); throw / timeout / sai định dạng → **reject** (fail closed) |
| Trần chi phí | `budget.ts` | `max_usd`, `max_usd_per_step`, `on_exceed: pause \| fail`; tách measured / estimated / blind |
| Bỏ qua step được phép fail | `optional`, `on_failure: continue` | |
| Huỷ an toàn | `shouldCancel` | Chỉ ở ranh giới step, có chủ đích (artifact viết dở sẽ lọt qua gate) |
| Tự commit artifact | `artifact_commit: on_approve` | Best-effort, lỗi git không làm hỏng run |
| Exit code | CLI | `0` xong, `2` dừng ở cổng, `1` lỗi |
| Trả việc về step trước | `rejectStep({ targetIdx })` | Có ở core, CLI (`--to`, commit `e1ef255`) và UI. Cursor chuyển về đích, đích sang `awaiting_work` → **loop chạy tiếp được ngay**, không cần sửa engine |

Điểm cuối cùng quan trọng: phần khó nhất của vòng tự sửa (cascade reset, feedback
`Rejected at step N (…)`, lịch sử `sentBackToIdx`) **đã có và đã test**. Phần
còn thiếu chủ yếu là nối dây.

---

## 3. Phân tích từng khoảng trống

### G1 — Không ai đọc verdict của verify/review

**Hiện trạng.**
- Skill `aidlc-native-review` yêu cầu kết thúc `review.md` bằng "một dòng verdict
  — **ship** hoặc **hold**". `aidlc-native-verify` yêu cầu "một dòng overall
  verdict". Cả hai đều là văn bản tự do, không có định dạng cố định.
- Pipeline `ai-native-full` để verify/review `autoReview: false`. Validator duy
  nhất được scaffold là `.aidlc/validators/ci.mjs`, và với `CHECKS = []` mặc định
  nó **luôn trả pass**.
- `produces_contains` chỉ kiểm tra một chuỗi **có mặt**, không kiểm tra giá trị
  (chứa `Verdict:` thì `Verdict: hold` cũng qua).

**Kịch bản lỗi.**
1. `aidlc run exec --auto-approve` → review ghi `hold` → `approveStep` → run
   `completed`. Exit 0, CI xanh.
2. **Đã xảy ra mà không cần autopilot:** recipe `native-lite` đặt
   `review: { human_review: false }` (`builtinWorkflows.ts:548`). Review ghi
   `hold` → Mark done tự approve → run `completed`. Mô tả recipe có nói "nobody
   reads it before the branch is finished", nhưng trạng thái `completed` thì nói
   ngược lại.

**Phương án.**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A** | Chuẩn hoá dòng cuối trong skill: `Verdict: ship` / `Verdict: hold` (verify: `pass` / `fail`). Thêm validator dùng chung `verdict.mjs` đọc dòng đó bằng regex | Rẻ. Không đổi core. Người đọc vẫn thấy rõ | LLM có thể viết sai định dạng. Phải **fail closed**: không tìm thấy verdict → reject |
| **B** | Agent ghi thêm file `review.verdict.json` (`{ verdict, blockers[] }`), khai báo trong `produces` | Có cấu trúc, mang được danh sách blocker cho G3 | Thêm một artifact. Hai nguồn sự thật (md và json) có thể lệch nhau |
| **C** | Core hỗ trợ sẵn: `verdict: { file, pattern, pass: [ship] }` trên step, không cần JS của người dùng | Không phải viết validator. UI có thể hiển thị verdict | Thêm schema, UI, migration. Phương án lớn nhất |

**Đề xuất: A**, fail closed. Validator trả `reason` là phần "shortest list of
changes" mà skill đã yêu cầu viết sau verdict, nên G3 có nội dung tốt để chuyển
tiếp. Chuyển sang C nếu sau này nhiều project cùng cần.

**Quyết định.**
- **D1a:** ✅ **Đã chốt: A** (2026-10-17).
- **D1b:** ✅ **Đã chốt: có** — gắn `verdict.mjs` cho review của `native-lite` ngay
  (sửa luôn kịch bản lỗi 2).
- **D1c:** ✅ **Đã chốt:** verify giữ `pass/fail`, review giữ `ship/hold`.

---

### G2 — Reject không trả việc về step trước

**Hiện trạng.** Validator chỉ trả `{ decision, reason }`.
`submitAutoReviewVerdict` reject **ngay tại step đó**
(`PipelineRunner.ts:497`: `sentBackToIdx: idx`). Loop gặp `rejected` → dừng.

Reject tại chỗ là đúng với `ci.mjs` trên `implement` (code chưa qua test → làm
lại `implement`). Nhưng nó vô nghĩa với verify/review: chạy lại review trên cùng
một đoạn code sẽ cho cùng kết quả. Thứ cần làm lại là `implement`.

**Phương án.**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A** | Verdict mang đích: `{ decision: 'reject', reason, sendBackTo: 'implement' }`. `submitAutoReviewVerdict` gọi logic cascade của `rejectStep` | Linh hoạt: validator tự quyết lỗi thuộc về `implement` hay `spec` | Logic định tuyến nằm trong JS của người dùng, khó nhìn từ cấu hình |
| **B** | Khai báo tĩnh trên step: `on_reject: { send_back_to: implement }` | Đọc được từ `workspace.yaml`. Validator giữ nguyên hợp đồng cũ | Không phân biệt được "lỗi code" với "lỗi spec" |
| **C** | B làm mặc định, A ghi đè khi cần | Có cả hai ưu điểm | Hai chỗ cấu hình |

**Đề xuất: B trước, mở rộng sang C khi có nhu cầu thật.** Gần như mọi lần
verify/review reject trong autopilot đều trả về `implement`. Lỗi thuộc về
`spec` / `intent` thì nên dừng cho người xử lý, không nên để máy tự sửa lại định
hướng.

Chi tiết cần lưu ý khi làm:
- `rejectStep` đã có sẵn cascade; chỉ cần `submitAutoReviewVerdict` gọi lại nó
  thay vì tự viết nhánh reject. Lịch sử sẽ có cả entry `auto_review` lẫn
  `reject` với `sentBackToIdx`.
- Trên pipeline có `depends_on`, chỉ các step phụ thuộc đích bị reset. Hành vi
  này đã có.
- **Sau G2, loop sẽ tự chạy vòng mà không cần sửa engine** (cursor về đích, đích
  `awaiting_work`). Vì vậy **G2 không được merge nếu thiếu G4.**

**Quyết định.**
- **D2a:** ✅ **Đã chốt: C** (2026-10-17) — `on_reject.send_back_to` tĩnh làm
  mặc định, verdict của validator được ghi đè bằng `sendBackTo`.

  Hệ quả khi làm:
  - `AutoReviewVerdict` thêm trường tuỳ chọn `sendBackTo` (index, tên step hoặc
    agent id, giải theo cùng quy tắc với `aidlc run reject --to`). Validator cũ
    không trả trường này vẫn chạy như trước.
  - Thứ tự ưu tiên: `sendBackTo` của verdict → `on_reject.send_back_to` của step
    → reject tại chỗ (hành vi hiện nay).
  - Đích không hợp lệ (không tồn tại, hoặc không nằm trước step bị reject) thì
    **không** lặng lẽ quy về reject tại chỗ như `rejectStep` đang làm: ghi lý do
    vào verdict và dừng run, vì đó là lỗi cấu hình hoặc lỗi validator.
  - `verdict.mjs` dùng chung (G1) chỉ cần trả `reject`; đích lấy từ cấu hình
    tĩnh. Ghi đè dành cho validator riêng của từng project.
  - Lịch sử ghi rõ đích đến từ đâu (`verdict` hay `config`), để khi đọc lại biết
    ai đã quyết định trả việc về.
- **D2b:** ✅ **Đã chốt** (2026-10-17): máy chỉ được tự trả việc về `implement`.
  Lỗi thuộc về định hướng (`intent`, `spec`, `build-plan`) thì dừng cho người.

  Cách hiện thực:
  - Đích tự động hợp lệ duy nhất là step khai báo trong `on_reject.send_back_to`
    (với recipe autopilot là `implement`). Verdict ghi đè `sendBackTo` chỉ được
    trỏ tới chính step đó. Ghi đè vì vậy chủ yếu dùng để **không** trả về, tức
    là dừng cho người (xem dòng dưới), chứ không dùng để chọn đích khác.
  - Verdict trỏ tới một step khác (ví dụ `spec`) → **không** cascade. Step bị
    reject tại chỗ, run dừng với exit 2, `rejectReason` ghi rõ "validator đề nghị
    trả về `spec`". Người đọc lý do rồi tự `aidlc run reject --to spec` hoặc
    **Send back to step N** nếu đồng ý.
  - Kiểm tra lúc nạp `workspace.yaml`: `send_back_to` phải trỏ tới một step nằm
    trước và **không** có `human_review: true`. Trỏ tới step có cổng người là
    lỗi cấu hình, vì việc trả về đó lẽ ra phải qua người.

---

### G3 — Feedback không tới agent khi chạy headless

**Hiện trạng.** Có hai đường chạy một step, và chúng đối xử với feedback khác
nhau:

| | Đường tương tác (**Run with Claude** trong extension) | Đường headless (`run exec`, **Run to completion**) |
|---|---|---|
| Prompt gửi đi | `/<slash> <epic> — Update artifact per feedback: "<fb>"` (`workspaceCommands.ts:462`) | Chỉ các cặp context, ví dụ `epic=EPIC-1` (`execEngine.ts`, `userMessage`) |
| Hợp đồng cấu trúc | Slash command có bước "Read `state.json` for prior feedback/history and address any rejection reasons" (`commandModel.ts:316`) | Prompt ghép từ persona + instructions + skills (`promptComposer.ts`). **Không có** câu này |
| Skill `aidlc-native-*` | Không nhắc tới feedback / `state.json` | như bên trái |

Kết quả: sau khi bị trả về, `implement` rev2 chạy headless với **đúng prompt của
rev1**. Có thể nó tình cờ đọc `review.md`, nhưng không có gì yêu cầu nó làm vậy.

**Lỗi này đã có ngay hôm nay**, không cần autopilot: Reject → Send back →
**Run to completion** sẽ chạy `implement` rev2 mà không biết vì sao.

**Phương án.**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A** | Trong `execStep`, khi `revision > 1`, thêm vào `userMessage` khối `step.feedback` + `rejectReason` + `autoReviewVerdict.reason` | Nhỏ, chắc chắn tới agent, đúng với mọi runner (Claude / Codex / Copilot) | Chỉ có lần reject gần nhất, không có cả lịch sử |
| **B** | Đưa câu "read `state.json` for prior feedback" vào `composeAgentPrompt` | Cùng hành vi với đường tương tác | Phụ thuộc agent có tool đọc file và chịu đọc. Không đảm bảo |
| **A+B** | Cả hai | A là bảo đảm, B cho thêm lịch sử | — |

**Đề xuất: A+B.** A gần như là sửa lỗi, có thể làm ngay và độc lập.

✅ **Đã chốt: A+B** (2026-10-17).

**Quyết định.**
- **D3:** ✅ **Đã chốt** (2026-10-17): **không cắt**, nhưng giữ mọi thứ ngắn ngay
  từ nguồn:
  - Khối feedback chèn vào message chỉ gồm nhãn và nội dung, không thêm lời dẫn.
    Ví dụ:
    ```
    Revision 2. Address before anything else:
    - Rejected at step 6 (review): <reason>
    ```
  - `reason` mà `verdict.mjs` trả về chỉ lấy phần "shortest list of changes" sau
    dòng verdict, không chép cả artifact.
  - Không lặp lại: một nội dung đã có trong `feedback` thì không chèn thêm lần
    nữa từ `rejectReason` / `autoReviewVerdict.reason`.
  - Câu thêm vào prompt ghép (phương án B) tối đa một dòng.

---

### G4 — Không có trần số vòng

**Hiện trạng.** Không có `max_revisions` hay tương đương. Thứ duy nhất chặn được
vòng lặp là `budget`, và nó có hai lỗ:
- Không bắt buộc: pipeline không khai báo `budget` thì không có trần.
- Step **blind** (runner không báo chi phí, ví dụ Codex chưa khai báo giá trong
  `providers:`) được cộng là `$0`. Một vòng toàn Codex có thể không bao giờ chạm
  trần.

**Kịch bản lỗi.** Review có một tiêu chí mà `implement` không thể đáp ứng (yêu cầu
mâu thuẫn, test flaky, policy không áp dụng được). Mỗi vòng tốn
`implement + verify + review`, lặp vô hạn.

**Phương án.**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A** | `max_revisions` trên step (ví dụ `implement: 3`). Engine kiểm tra trước `execStep`; vượt trần → outcome mới `revision_limit`, exit 2 | Dễ hiểu, cấu hình theo step | Không bắt được vòng giữa các step khác nhau |
| **B** | `max_send_backs` trên pipeline/run: đếm entry lịch sử có `sentBackToIdx < idx` | Bắt đúng thứ nguy hiểm (vòng tự sửa) | Trừu tượng hơn với người cấu hình |
| **C** | Phát hiện không tiến triển: hai vòng liền có cùng reason → dừng | Dừng sớm, tiết kiệm | Heuristic, so chuỗi do LLM viết thì không ổn định |

**Đề xuất: B, mặc định 3 khi bật send-back tự động**, có thể thêm A sau. Khi
dừng, `onRejected` / exit 2 phải nói rõ "đã trả về N lần" để người xử lý biết
đó là bế tắc chứ không phải lỗi thường.

**Quyết định.**
- **D4a:** ✅ **Đã chốt: B + C** (2026-10-17). Không làm A.
  - **B** là trần cứng: đếm số lần trả việc về. Bộ đếm **đặt lại khi người can
    thiệp** (Approve, Send back bằng tay, Rerun, Request update), để lịch sử sửa
    tay trước đó không làm run chạm trần ngay khi bắt đầu.
  - **C** là dừng sớm, so theo **code chứ không theo chữ**: nếu `implement` rev
    N+1 không làm thay đổi gì so với rev N (dấu vân tay tree của nhánh / diff
    so với base), dừng ngay. Tất định, bắt được trường hợp agent không sửa được
    code (G5). So `reason` do LLM viết thì không ổn định nên không dùng.
  - **Không làm A**, vì autopilot **không** tự chạy lại khi CI fail: `ci.mjs`
    reject `implement` thì loop vẫn dừng như hiện nay. Nếu sau này muốn tự sửa
    khi CI đỏ, đó là vòng `implement → ci → implement` mà B không đếm, và A trở
    nên cần thiết.
  - Hai lớp chặn các kiểu kẹt khác nhau: C dừng sớm khi lặp y nguyên; B chặn
    dao động và test flaky mà C không thấy. Cái giá đã biết: B có thể dừng oan
    một run đang tiến triển chậm (mỗi vòng sửa được một blocker); khi đó người
    chỉ cần cho chạy tiếp.
  - Khi dừng, lý do phải nói rõ là trần nào: "đã trả về 3 lần" hay "rev N không
    thay đổi code so với rev N-1".
- **D4b:** ✅ **Đã chốt: `max_send_backs` mặc định 3.**
- **D4c:** ✅ **Đã chốt: không bắt buộc `budget`** (2026-10-17), vì chi phí hiện
  chưa tính được chính xác (step blind cộng là `$0`, giá ước tính phụ thuộc rate
  tự khai báo). Trần của autopilot vì vậy là **số vòng** (B + C), không phải
  tiền. `budget` vẫn dùng được nếu project khai báo; xem lại quyết định này khi
  mọi runner báo được chi phí.

---

### G5 — Quyền tool khi chạy headless

**Hiện trạng.**
- `DefaultRunner` gọi `claude --print …` không có cờ quyền nào. `extraArgs` có
  trong constructor nhưng `RunnerRegistry.ts:34` khởi tạo `new DefaultRunner()`
  không tham số, nên **không cấu hình được từ `workspace.yaml`**.
- Ở chế độ `--print` không có ai bấm "Allow". Quyền của `implement`/`verify`
  (Edit, Bash để chạy test) phụ thuộc hoàn toàn vào `permissions.allow` trong
  `.claude/settings.json`, mà file này **bị gitignore** và mỗi clone tự tạo.
- Approval gate (`.claude/hooks/aidlc-approval-gate.py`: chặn force-push lên
  `main`, chặn stage `.env`, chặn sửa tay `state.json`) cũng đăng ký trong chính
  file đó, và **fail open**.

**Kịch bản lỗi.**
1. Thiếu allow list: `implement` không sửa được code nhưng vẫn ghi
   `implement.md` → qua `produces` → verify fail → vòng lặp tốn tiền mà không có
   tiến triển (G4 chặn được, nhưng lãng phí).
2. Người dùng "sửa nhanh" bằng `--dangerously-skip-permissions` hoặc allow
   `Bash(*)`, trong khi không có hook → agent không người trông có toàn quyền
   shell trên máy.

**Phương án.**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A** | Chỉ tài liệu + `aidlc doctor` kiểm tra allow list và hook | Không đổi runner | Vẫn dựa vào cấu hình tay của từng máy |
| **B** | Cấu hình runner trong `workspace.yaml`, ví dụ `runners: { default: { args: [--permission-mode, acceptEdits, --allowedTools, "Bash(pnpm test:*)"] } }`, nối vào `extraArgs` | Commit được, cả team cùng một cấu hình | Thêm schema. Cần ràng buộc để không ai commit `--dangerously-skip-permissions` |
| **C** | Chỉ chạy autopilot trong worktree / container, ở đó mới cho bỏ qua quyền | An toàn nhất, cho phép tự do nhất | Hạ tầng nặng, ngoài phạm vi repo này |

**Đề xuất: B + A.** Thêm vào đó: khi chạy autopilot, `doctor` (hoặc chính
`run exec`) **từ chối chạy** nếu thiếu approval gate, thay vì chỉ cảnh báo.

**Quyết định.**
- **D5a:** A / B / C. ✅ **Chốt: B + A** — `runners.*.args` trong
  `workspace.yaml` (chặn `--dangerously-skip-permissions` khi load) + `doctor`
  kiểm tra allow list và hook.
- **D5b:** có bắt buộc approval gate cho autopilot không? Hook có nên đổi sang
  fail closed khi chạy không người trông? ✅ **Chốt: có** — `run exec`
  autopilot từ chối chạy nếu thiếu hook; hook fail closed chỉ khi chạy
  autopilot, chế độ tương tác giữ fail open.
- **D5c:** autopilot có được chạy thẳng trên working tree hiện tại, hay bắt buộc
  một nhánh/worktree riêng? ✅ **Chốt: nhánh riêng** — kiểm tra trước khi
  chạy: không chạy trên `main`, working tree phải sạch. Worktree để sau.

---

### G6 — Chưa có recipe dành cho autopilot

**Hiện trạng.** `ai-native-full` để mọi phase `humanReview: true`,
verify/review `autoReview: false`. `native-lite` bỏ cổng người ở
implement/review nhưng không có gì thay thế (G1). `ci.mjs` có `CHECKS` rỗng nên
luôn pass.

**Đề xuất.** Thêm recipe `native-autopilot` sau khi G1–G5 xong:

| Step | Người duyệt | Validator | Khi reject |
|---|---|---|---|
| `intent` | ✔ | — | — |
| `build-plan` | ✔ | — | — |
| `implement` | — | `ci.mjs` (CHECKS **bắt buộc khác rỗng**) | tại chỗ, rerun |
| `verify` | — | `verdict.mjs` | về `implement` |
| `review` | ✔ (D6) | `verdict.mjs` | về `implement` |

Kèm theo: `max_send_backs: 3` + dừng khi code không đổi, `budget` tuỳ chọn
(D4c), `batches: true` cho `implement` (G7), `timeout_minutes` (implement 30/đợt, còn lại 20 — R1, D7c), `doctor` báo lỗi nếu `ci.mjs` còn `CHECKS = []`.

**Quyết định.**
- **D6:** review `ship` thì run `completed` luôn (người chỉ merge PR), hay vẫn
  dừng ở `awaiting_review` để người Approve trong AIDLC rồi mới merge?
  ✅ **Chốt: B** — dừng chờ người Approve. `hold` vẫn tự gửi về `implement`;
  người chỉ xem một lần ở cuối. Khi đã tin validator, đổi
  `human_review: false` là thành A, không cần sửa code.
- **D6b:** recipe gồm `spec` hay không? ✅ **Chốt: không** — epic cần spec thì
  dùng `ai-native-full` + autopilot.

---

### G7 — `implement` chạy cả plan trong một phiên

**Hiện trạng.** `aidlc-native-implement` làm hết `Order` của `plan.md` trong một
phiên `claude --print`. `implement.md` chỉ ghi ở cuối, không có nhật ký tiến độ.
Headless không có `/compact`: phiên dài chỉ trông vào auto-compact (mất thông tin,
không kiểm soát). Đối chiếu: `cr-build` (s-tos-microservice) chia đợt, ghi
`build-log.md` sau mỗi task, dừng giữa các đợt để review / `/compact`.

**Hệ quả với các quyết định khác.** Timeout R1 áp cho cả step → plan lớn bị cắt
hoặc timeout vô nghĩa. Fingerprint D4a-C đo cả step → treo ở đợt 3 vẫn tính là
"có tiến triển".

**Phương án.**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A** | Skill chia đợt; mỗi đợt một phiên `claude` mới, `implement.md` mang tiến độ + `Status: continue\|done`; engine thấy `continue` thì spawn lại | Giống `cr-build`; engine không cần hiểu plan | Mỗi đợt đọc lại plan/spec/`CLAUDE.md` |
| **B** | Engine parse `Order` và spawn một phiên mỗi mục | Ranh giới cứng | Parse markdown dễ vỡ; không bẻ theo ngữ cảnh |
| **C** | Một phiên, dựa auto-compact | Không tốn công | Đúng vấn đề cần tránh; xung đột timeout |

✅ **Chốt: A.**
- **D7a — ai chia:** `build-plan` nhóm `Order` thành các đợt (người duyệt plan là
  duyệt cách chia). `implement` được bẻ nhỏ hơn khi thiếu ngữ cảnh, không được gộp.
- **D7b — tín hiệu:** dòng `Status: continue` / `Status: done` cuối `implement.md`,
  bật bằng `batches: true` trên step. Đã bật mà thiếu / sai định dạng → lỗi (fail
  closed). Step không bật chạy như cũ.
- **D7c — trần:** `max_batches: 10`. Timeout R1 tính **mỗi đợt** (30 phút).
  Fingerprint D4a-C cũng theo đợt: đợt không đổi code → dừng.
- **D7d — dừng giữa đợt:** autopilot không dừng. Thêm `pause_between_batches` cho
  chế độ bán tự động (giống `cr-build`).
- **D7e — rev2:** bắt đầu bằng một đợt sửa theo feedback; bảng tiến độ rev1 giữ
  nguyên để agent biết phần đã xong.

---

## 4. Rủi ro còn lại

- **Huỷ chỉ có hiệu lực ở ranh giới step.** Một `implement` dài không dừng được
  giữa chừng, và runner không có timeout → `claude` treo thì run đứng mãi, không
  bao giờ ra exit code (trần D4 và thông báo R2 đều không chạy). Lý do gốc
  ("artifact viết dở lọt `produces`") đã được `snapshotProduces` vá; code dở
  chưa commit bị D5c chặn ở run sau.
  ✅ **Chốt: B + C.**
  - **B — huỷ cứng:** `AbortSignal` xuống `runner.run` → `SIGTERM` cả process
    group (`detached` + `kill(-pid)`; Windows `taskkill /T`), ~10s sau `SIGKILL`.
    Step giữ `awaiting_work`, history ghi "huỷ giữa step". Hai cấp: lần 1 huỷ
    mềm (như cũ), lần 2 dừng ngay (CLI: Ctrl+C lần hai; extension: nút "Stop now").
  - **C — `timeout_minutes` theo step:** mặc định không giới hạn; recipe
    `native-autopilot` đặt `implement: 30` (mỗi đợt — D7c), còn lại `20`. Hết giờ = step lỗi,
    exit 1, không gửi lại, không tính vào `max_send_backs`.
  - Sửa comment `shouldCancel` cho đúng lý do mới. Làm trong PR G5 (cùng sửa
    runner), trước G6.
- **Không có thông báo khi dừng.** Run dừng ở exit 2 lúc 2 giờ sáng thì không ai
  biết. Cần webhook hoặc notification, nhưng có thể làm sau.
  ✅ **Chốt: không làm trong đợt này.** Hướng khi làm: `on_stop: <lệnh shell>`
  trong `workspace.yaml`, nhận exit code + lý do qua biến môi trường. Tạm thời
  dựa vào exit code 0/1/2 + thông báo chạm trần (D4a).
- **Trạng thái git giữa các vòng.** `implement` rev2 làm việc trên cùng nhánh với
  rev1. Chưa có quy ước commit / amend / squash giữa các revision.
  ✅ **Chốt:** từ rev2 `implement` làm tiếp trên cùng nhánh + PR, chỉ thêm commit
  (không amend, không force-push) — một dòng trong skill, đi cùng PR G3.
  Fingerprint cho D4a-C = `HEAD` sha + hash `git status --porcelain`/diff, lấy
  trước và sau `implement`. D5c chỉ kiểm tra tree sạch lúc bắt đầu run.
- **Chi phí blind** vẫn là lỗ của `budget` cho tới khi mọi runner báo giá hoặc
  người dùng khai báo rate. ✅ Chấp nhận — xem D4c.
- **Chạy đồng thời.** Loop đọc lại state mỗi vòng nên chịu được việc
  extension/CLI cùng sửa, nhưng hai `run exec` trên cùng một run thì không có
  khoá.
  ✅ **Chốt:** lockfile `.aidlc/runs/<id>.lock` (pid, tạo exclusive, pid chết
  thì chiếm lại) đặt trong `runExecLoop` — phủ cả CLI lẫn extension. Đi cùng
  PR G2 + G4.

---

## 5. Kế hoạch triển khai đề xuất

| Bước | Nội dung | Có ích khi chưa bật autopilot? | Kiểm thử |
|---|---|---|---|
| 1 | **G3**: feedback vào user message (+ câu đọc `state.json` trong prompt ghép) | Có — sửa Send back → Run to completion | Unit test `execStep` với `revision: 2`; chạy tay `--dry-run` để xem prompt |
| 2 | **G1**: chuẩn hoá dòng verdict trong 2 skill + `verdict.mjs` fail closed | Có — sửa `native-lite` | Unit test validator: ship / hold / thiếu / sai định dạng |
| 3 | **G2 + G4**: `on_reject.send_back_to` + `max_send_backs` | Không | Test core: verdict reject → cascade, cursor về `implement`; vượt trần → dừng |
| 4 | **G5**: `runners.*.args` + doctor kiểm tra hook/allow list + huỷ cứng / `timeout_minutes` (R1) | Có một phần | Test registry; e2e trên scratch workspace |
| 5 | **G7**: `batches: true` + `Status: continue\|done`, `build-plan` chia đợt, skill `implement` ghi tiến độ | Có — plan lớn chạy được | Test core: `continue` → spawn lại cùng revision; thiếu dòng → lỗi; chạm `max_batches` → dừng |
| 6 | **G6**: recipe `native-autopilot` + tài liệu | — | E2E: epic nhỏ, review cố ý hold một lần, kiểm tra vòng về `implement` rồi ship |

## 6. Bảng quyết định

| Mã | Câu hỏi | Quyết định |
|---|---|---|
| D0 | Định nghĩa autopilot; người vẫn merge? | ✅ **Chốt: đồng ý** — người Approve + merge |
| D1a | Cách đọc verdict | ✅ **Chốt: A** — dòng `Verdict:` + `verdict.mjs`, fail closed |
| D1b | Sửa `native-lite` ngay? | ✅ **Chốt: có** |
| D1c | Từ vựng verdict verify | ✅ **Chốt: giữ `pass/fail`** (review giữ `ship/hold`) |
| D2a | Định tuyến khi reject | ✅ **Chốt: C** — tĩnh làm mặc định, verdict ghi đè |
| D2b | Đích được phép | ✅ **Chốt:** chỉ `implement`; lỗi định hướng dừng cho người |
| D3 | Cắt feedback dài? | ✅ **Chốt:** không cắt; câu chữ chèn vào phải ngắn, không lặp |
| D4a | Loại trần | ✅ **Chốt: B + C** — `max_send_backs` + dừng khi code không đổi; không làm A |
| D4b | Giá trị mặc định | ✅ **Chốt: 3** |
| D4c | Bắt buộc `budget`? | ✅ **Chốt: không** — chi phí chưa tính chính xác; trần là số vòng |
| D5a | Quyền tool | ✅ **Chốt: B + A** |
| D5b | Bắt buộc approval gate? | ✅ **Chốt: có** — từ chối chạy nếu thiếu; fail closed chỉ khi autopilot |
| D5c | Nhánh/worktree riêng? | ✅ **Chốt: nhánh riêng** — chặn `main` + tree bẩn; worktree để sau |
| D6 | Review ship → completed hay chờ người? | ✅ **Chốt: B** — chờ người Approve |
| D6b | Recipe có `spec`? | ✅ **Chốt: không** — cần spec thì dùng `ai-native-full` + autopilot |
| D7 | Chia `implement` thành đợt | ✅ **Chốt: A** — skill chia, mỗi đợt một phiên mới |
| D7a | Ai chia đợt? | ✅ **Chốt:** `build-plan`; `implement` chỉ được bẻ nhỏ hơn |
| D7b | Tín hiệu | ✅ **Chốt:** `Status: continue\|done` + `batches: true`, fail closed |
| D7c | Trần | ✅ **Chốt:** `max_batches: 10`, timeout 30 phút/đợt, fingerprint theo đợt |
| D7d | Dừng giữa đợt? | ✅ **Chốt:** autopilot không; có `pause_between_batches` |
| D7e | Rev2 | ✅ **Chốt:** một đợt sửa theo feedback, giữ bảng tiến độ |
