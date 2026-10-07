# v0.2 Fixing Plan & Progress Tracker

Dokumen ini adalah tracker implementasi untuk menutup gap yang telah diverifikasi pada review Playwright MCP v0.2. Dokumen roadmap utama tetap berada di `docs/adjustment-mcp-3.md`; file ini berfokus pada pekerjaan perbaikan, acceptance criteria, regression test, dan kesiapan release.

> **Status:** Sprint 0–6 selesai, termasuk Sprint 2E (temuan review lanjutan). Semua P0/P1 tertutup dan seluruh release gate lokal lulus. Versi 0.2.0 dan lisensi MIT sudah ditetapkan; CI/CD sengaja ditunda; lihat [§8 Sisa pekerjaan](#8-sisa-pekerjaan--keputusan-yang-dibutuhkan).
>
> **Last updated:** 2026-10-07

---

## 1. Status keseluruhan

| Area | Status | Prioritas | Catatan |
|---|---|---:|---|
| Baseline dan test foundation | ✅ Done | P0 | 73 test (46 unit, 25 integration, 2 e2e opt-in) |
| Security dan input validation | ✅ Done | P0 | Path boundary, symlink, safe identifier (maks. 64 karakter), report authorization, batas ukuran report |
| Runner reliability | ✅ Done | P0 | Sprint 2A–2E; cancellation MCP, shutdown, workspace/monorepo, kategori error |
| Browser diagnostics | ✅ Done | P1 | Event asli dari `trace.zip` dan fixture diagnostics; tervalidasi pada Playwright 1.62.1 |
| Reporter integration | ✅ Done | P1 | Wrapper config mempertahankan reporter HTML/Allure proyek |
| Quality scoring | ✅ Done | P1 | Berbasis TypeScript AST; komentar/string/TODO tidak lagi dihitung |
| Scaffold quality | ✅ Done | P1 | Skeleton eksplisit (`test.fixme` + `@mcp-skeleton`), lolos `tsc --strict` |
| MCP output contract | ✅ Done | P2 | `outputSchema` + `structuredContent` di semua tool; error `{ code, message, details }` |
| Token optimization | ✅ Done | P2 | Summary ≤ 6.000 karakter (terukur); run gagal tipikal ≈ 3.500 karakter |
| Config audit dan documentation | ✅ Done | P2 | Audit AST (literal/expression/missing), README, CHANGELOG, catatan RESEARCH_CONTEXT |
| Release hygiene | ✅ Done | P2 | Versi 0.2.0 sinkron, lisensi MIT, `npm audit` 0. CI/CD ditunda (S6-08) |

### Status legend

- `⬜ Todo` — belum dimulai
- `🔄 In Progress` — sedang dikerjakan
- `✅ Done` — implementasi dan verification gate selesai
- `⏸️ Blocked` — menunggu keputusan atau dependency
- `❌ Rejected` — tidak dikerjakan berdasarkan keputusan
- `📝 Deferred` — dipindahkan ke release/roadmap berikutnya

---

## 2. Baseline terverifikasi

### Gap awal (review v0.2) dan penutupnya

| # | Gap | Ditutup di |
|---:|---|---|
| 1 | Scaffolding belum memvalidasi path/identifier secara ketat | S1-01–S1-05 |
| 2 | `get_failure_details.reportPath` tanpa containment guard | S1-06 |
| 3 | Runner mengabaikan exit code, signal, `report.errors` | S2B |
| 4 | Tidak ada timeout/cancellation terkontrol | S2C, S2E-02 |
| 5 | `--reporter=json` menonaktifkan reporter proyek | S3-07 |
| 6 | Console/network diagnostics tidak berasal dari browser | S3-01–S3-06 |
| 7 | Status `flaky`/`interrupted` tidak dipetakan aman | S2D-01 |
| 8 | Scoring memindai raw source (komentar/TODO jadi false positive) | S4-01–S4-04 |
| 9 | Scaffold tampak seperti test lengkap tanpa assertion | S4-05–S4-08 |
| 10 | Payload MCP terlalu besar | S5-04–S5-07 |
| 11 | Tidak ada structured output schema | S5-01–S5-03 |
| 12 | `npm test` placeholder | S0-01 |
| 13 | Versi `package.json` dan lockfile berbeda | S6-06 |
| 14 | Dokumentasi menyebut tool yang sudah dihapus | S6-04, S6-05 |

### Temuan tambahan dari review lanjutan (2026-10-07)

Ditemukan saat memvalidasi terhadap Playwright asli (1.62.1); fixture lama tidak menangkapnya.

1. JSON reporter Playwright tidak punya `test.testId`; yang ada `spec.id` + `test.projectId`. Akibatnya semua ID memakai fallback posisi, dan spec yang sama di beberapa project menghasilkan judul kembar tanpa `projectName`.
2. Pesan error Playwright mengandung ANSI escape (`\u001b[2mexpect(`), sehingga regex kategori error tidak pernah cocok. Urutan kategori juga salah: hampir semua error mengandung kata "Timeout".
3. JSON reporter tidak mengirim `steps`, sehingga `recentSteps` selalu kosong pada run asli.
4. `consoleErrors` berasal dari stderr proses test, bukan console browser.
5. Cancellation MCP (`extra.signal`) tidak tersambung. Listener `SIGINT` di tool menahan server, dan child `detached` tertinggal bila server mati.
6. Monorepo (Playwright di-hoist ke root workspace) terdeteksi `setup_required`. Deteksi browser tidak memeriksa revisi maupun `channel`.
7. `generate_test_report` memakai `execSync("npx …")`: sinkron, tanpa timeout, dan bertentangan dengan keputusan "no npx".
8. Direktori report sementara tidak pernah dibersihkan.
9. `dist/` berisi modul basi dari tool yang sudah dihapus dan ikut ter-publish.
10. `fast-glob` dan `diff` tidak lagi dipakai, tetapi membawa advisory `npm audit`.

---

## 3. Urutan dependency

```text
Sprint 0: Baseline & test foundation                    ✅
    ↓
Sprint 1: Security & input validation                   ✅
    ↓
Sprint 2: Runner reliability (2A–2E)                    ✅
    ↓
Sprint 3: Browser diagnostics & reporter integration    ✅
    ↓
Sprint 4: Quality scoring & scaffold quality            ✅
    ↓
Sprint 5: MCP contract & token optimization             ✅
    ↓
Sprint 6: Config audit, documentation & release         ✅ (CI ditunda)
```

---

## 4. Sprint plan

## Sprint 0 — Baseline & Test Foundation — ✅ Done

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S0-01 | Ganti script `npm test` placeholder dengan test runner yang benar | P0 | ✅ Done | `package.json` | `npm test` exit 0 |
| S0-02 | Buat unit-test structure dan shared fixtures | P0 | ✅ Done | `test/unit`, `test/integration`, `test/e2e`, `test/helpers` | Test discovery berhasil |
| S0-03 | Tambahkan fixture valid/malformed/empty Playwright JSON report | P0 | ✅ Done | `test/fixtures/reports` | Parser flattening dan fixture coverage |
| S0-04 | Tambahkan fixture failed/timeout/interrupted/flaky/config-error run | P0 | ✅ Done | `test/fixtures/reports` | Status mapping test |
| S0-05 | Tambahkan baseline command untuk build, test, dan whitespace check | P1 | ✅ Done | `package.json`, `.gitignore` | `npm run build`, `npm test`, `git diff --check` |
| S0-06 | Fixture asli Playwright 1.62.1 (report JSON + `trace.zip`) | P1 | ✅ Done | `test/fixtures/reports/playwright-1.62-failed.json`, `test/fixtures/traces/console-network.zip` | Unit test parser dan diagnostics |
| S0-07 | `--test-timeout` di semua script test | P1 | ✅ Done | `package.json` | Test yang hang gagal, tidak memblokir |

### Catatan

- Default suite deterministik tanpa network eksternal. Suite e2e (`test/e2e`) opt-in lewat `PW_MCP_REAL_PLAYWRIGHT_WORKSPACE`.
- Path di fixture asli disanitasi menjadi `/project/...`.
- `docs/` di-ignore secara default; hanya `docs/fixing.md` yang dikecualikan.

---

## Sprint 1 — Security & Input Validation — ✅ Done

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S1-01 | Validasi `featureName` dengan aturan identifier/path yang aman | P0 | ✅ Done | `src/tools/scaffoldTestDomain.ts`, `src/lib/safeIdentifier.ts` | Unit/integration security tests |
| S1-02 | Validasi setiap item `steps` | P0 | ✅ Done | `src/tools/scaffoldTestDomain.ts`, `src/lib/safeIdentifier.ts` | Traversal/special-character tests |
| S1-03 | Tolak duplicate, empty, whitespace, separator, `..`, quote, backtick, newline, dan identifier > 64 karakter | P0 | ✅ Done | `src/lib/safeIdentifier.ts` | Negative tests |
| S1-04 | Guard semua output scaffold terhadap `projectRoot` | P0 | ✅ Done | `src/tools/scaffoldTestDomain.ts`, `src/lib/pathSecurity.ts` | Root containment tests |
| S1-05 | Periksa symlink escape pada target scaffold | P1 | ✅ Done | `src/lib/pathSecurity.ts` | Symlink security test |
| S1-06 | Guard `get_failure_details.reportPath` terhadap root/report directory | P0 | ✅ Done | `src/tools/getFailureDetails.ts`, `src/lib/reportRegistry.ts` | Arbitrary-file/read-outside tests |
| S1-07 | Validasi ukuran, encoding, dan schema minimum report | P1 | ✅ Done | `src/tools/runPlaywrightTest.ts`, `src/tools/getFailureDetails.ts` | Report > 50 MB ditolak (`REPORT_TOO_LARGE`); wajib array `suites` (`REPORT_MALFORMED`); dibaca sebagai UTF-8 |
| S1-08 | Standarkan error code untuk validation dan file access | P1 | ✅ Done | `src/lib/toolErrors.ts` | Digabung dengan S5-03 |
| S1-09 | Attachment dari report in-project hanya dibaca di dalam project root | P1 | ✅ Done | `src/tools/getFailureDetails.ts` | `canReadPath` + `validatePathWithinRoot`; report hasil runner dipercaya |

### Acceptance criteria

- [x] Input valid menghasilkan path yang hanya berada di bawah `projectRoot`.
- [x] Input seperti `../../outside`, `foo/bar`, `foo\\bar`, backtick, quote, newline, string kosong, dan nama terlalu panjang ditolak.
- [x] Tidak ada file atau directory yang dibuat sebelum semua input tervalidasi.
- [x] `get_failure_details` tidak dapat membaca file JSON arbitrary di luar project root atau report directory resmi.
- [x] Symlink yang mengarah keluar root ditolak.
- [x] Error menyebut field yang invalid tanpa membocorkan isi file.

---

## Sprint 2 — Runner Reliability — ✅ Done

### Sprint 2A — Prerequisite preflight — ✅ Done

| ID | Task | Status | Verification |
|---|---|---|---|
| S2A-01 | Read-only target-project prerequisite detection | ✅ Done | Unit tests for missing and partial Playwright/Allure setups |
| S2A-02 | Register `check_test_prerequisites` MCP tool | ✅ Done | MCP handshake tool catalog test |
| S2A-03 | Gate runner before execution and avoid implicit downloads | ✅ Done | Runner setup status and local CLI invocation |
| S2A-04 | Document manual setup path | ✅ Done | README and this tracker |

### Sprint 2B — Process outcome & report-error classification — ✅ Done

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S2B-01 | Capture exit code, signal, spawn error, stdout, dan bounded stderr | P0 | ✅ Done | `src/lib/runnerProcess.ts`, `src/tools/runPlaywrightTest.ts` | Unit + fake CLI integration tests |
| S2B-02 | Classify `report.errors`, missing/malformed report, empty suite, dan process failure | P0 | ✅ Done | `src/lib/runnerClassification.ts` | Classification matrix + fake CLI integration tests |
| S2B-03 | Expose runner metadata dan runner error category pada output | P0 | ✅ Done | `src/tools/runPlaywrightTest.ts` | Output contract + fake CLI integration test |

### Sprint 2C — Timeout, cancellation, signal & cleanup — ✅ Done

**Decision:** timeout default `120000ms`, minimum `100ms`, maksimum `900000ms`. Process group dihentikan dengan SIGTERM, lalu SIGKILL setelah 500 ms.

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S2C-01 | Validated timeout input dengan default/min/max | P0 | ✅ Done | `src/lib/runnerProcess.ts`, `src/tools/runPlaywrightTest.ts` | Bound tests |
| S2C-02 | Timeout dan cancellation menghasilkan metadata eksplisit | P0 | ✅ Done | `src/lib/runnerProcess.ts`, `src/lib/runnerClassification.ts` | Delayed-process + fake CLI tests |
| S2C-03 | Kill process tree dan cleanup idempotent | P0 | ✅ Done | `src/lib/runnerProcess.ts` | Process-group timeout escalation integration test |

### Sprint 2D — Status fidelity, retry artifacts & stable identity — ✅ Done

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S2D-01 | Preserve `flaky` dan `interrupted` status | P1 | ✅ Done | `src/lib/playwrightReport.ts` | Status fixture + fake CLI integration tests |
| S2D-02 | Expose retry attempts dan aggregate attachment lintas retry | P1 | ✅ Done | `src/lib/playwrightReport.ts`, `src/tools/runPlaywrightTest.ts` | Retry attachment unit + fake CLI integration tests |
| S2D-03 | Generate stable test identity dan require it for duplicate titles | P1 | ✅ Done | `src/lib/playwrightReport.ts`, `src/tools/getFailureDetails.ts` | Duplicate-title integration + fake CLI lookup test |

### Sprint 2E — Temuan review lanjutan — ✅ Done

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S2E-01 | `testId` = `spec.id:projectId`, plus `projectName` dan `fullTitle` | P0 | ✅ Done | `src/lib/playwrightReport.ts` | Fixture asli 1.62 + test multi-project + e2e |
| S2E-02 | Sambungkan cancellation MCP (`extra.signal`); hapus listener SIGINT di tool; matikan process group saat server berhenti (SIGINT/SIGTERM/stdin ditutup/exit) | P0 | ✅ Done | `src/index.ts`, `src/lib/runnerProcess.ts` | AbortSignal integration test; handshake test memastikan server keluar dengan kode 0 saat stdin ditutup |
| S2E-03 | Dukungan monorepo: package di-hoist ke workspace root (npm/yarn `workspaces`, pnpm, lerna) diterima; package liar dari parent yang bukan workspace tetap ditolak | P0 | ✅ Done | `src/lib/prerequisites.ts` | Unit tests workspace/stray parent; e2e berjalan via workspace |
| S2E-04 | Allure generation async lewat CLI lokal (tanpa `npx`), dengan timeout, cancellation, exit code, dan stderr | P0 | ✅ Done | `src/tools/generateTestReport.ts` | Fake Allure CLI: sukses, exit 2, hang/timeout, tanpa index, tanpa CLI |
| S2E-05 | Strip ANSI dan perbaiki urutan `categorizeError` (network → locator → assertion → locator wait → timeout) | P1 | ✅ Done | `src/lib/playwrightReport.ts`, `src/lib/text.ts` | Matriks pesan error asli |
| S2E-06 | Kelola direktori report sementara: retensi 20 run terakhir, hapus saat exit, buang direktori tanpa report | P1 | ✅ Done | `src/lib/reportRegistry.ts` | Retention integration test |
| S2E-07 | Revisi browser dicocokkan dengan `playwright-core/browsers.json` (termasuk `revisionOverrides`), unduhan tidak lengkap diabaikan, `channel` (chrome/msedge) dikenali | P1 | ✅ Done | `src/lib/prerequisites.ts` | Unit test outdated/incomplete/channel/override |
| S2E-08 | Decode UTF-8 lintas chunk (`StringDecoder`); listener `error` tidak lagi bisa crash setelah spawn | P2 | ✅ Done | `src/lib/runnerProcess.ts` | Unit runner tests |

### Verification matrix Sprint 2

| Scenario | Expected result | Coverage |
|---|---|---|
| Exit 0 + valid passed report | `passed` | classification + fake CLI integration + e2e |
| Exit non-zero + test failure | `failed` + process metadata | classification + fake CLI integration + e2e |
| Spawn error / missing report / malformed JSON / empty suite | `runner_error` dengan `kind` spesifik | unit + fake CLI integration |
| `report.errors` | `runner_error/report_error`, tidak pernah `passed` | fixture + classifier + fake CLI |
| Timeout / cancellation (AbortSignal MCP) / signal | `timedout` / `interrupted`, bounded duration, cleanup | delayed-process + process-group + AbortSignal integration |
| Retry pass-after-failure | `flaky`, attempts lengkap, diagnostics dari attempt yang gagal | parser + fake CLI integration |
| Spec sama di dua project | `testId` berbeda, `projectName` terisi; lookup tanpa ID ditolak | unit + e2e |
| Server berhenti saat run berjalan | process group di-SIGKILL, wrapper dan report sementara dihapus | handshake test (exit 0) + exit handler |

---

## Sprint 3 — Browser Diagnostics & Reporter Integration — ✅ Done

**Keputusan:** diagnostics hanya berasal dari event browser asli, lewat dua sumber yang saling melengkapi:

1. **`trace.zip`** dari attempt yang gagal, untuk semua test dengan `use.trace` aktif. Dibaca dengan pembaca zip internal (`zlib`, tanpa dependency baru) yang dibatasi ukuran arsip 200 MB dan ukuran entry 32 MB.
2. **Fixture `support/diagnostics.fixture.ts`** hasil scaffold: auto fixture `page.on('console' | 'pageerror' | 'requestfailed' | 'response')` yang meng-attach `mcp-diagnostics` saat test tidak berakhir dengan status yang diharapkan.

Reporter dipertahankan dengan **wrapper config sementara** (`.pw-mcp-<pid>-<rand>.config.ts`) yang ditulis di samping config proyek, meng-import config itu tanpa perubahan, lalu menambahkan reporter JSON.

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S3-01 | Console error/warning dari event browser | P1 | ✅ Done | `src/lib/browserDiagnostics.ts`, template fixture | Trace fixture asli + fixture attachment test + e2e |
| S3-02 | `pageerror` | P1 | ✅ Done | idem | idem |
| S3-03 | `requestfailed` | P1 | ✅ Done | idem | `net::ERR_CONNECTION_REFUSED` dari trace asli |
| S3-04 | Response HTTP `4xx/5xx` | P1 | ✅ Done | idem | HTTP 500 dari trace asli + e2e |
| S3-05 | Kaitkan event dengan test/attempt yang benar | P1 | ✅ Done | `src/lib/failureDiagnostics.ts`, `src/lib/playwrightReport.ts` | Diagnostics dibaca per test dari `failedAttemptAttachments` |
| S3-06 | Batasi jumlah event dan panjang message | P1 | ✅ Done | `src/lib/browserDiagnostics.ts` | Console 10, page error 5, request 10, teks 500 karakter; `diagnosticsOmitted` |
| S3-07 | Pertahankan reporter HTML/Allure proyek saat menghasilkan JSON | P1 | ✅ Done | `src/lib/runConfig.ts`, `src/tools/runPlaywrightTest.ts` | Lab: TS/MTS/CJS/ESM/ESM-di-CJS; fake CLI; e2e (`html-out/index.html` terbentuk) |
| S3-08 | Verifikasi output native HTML, Allure, dan quality report | P1 | ✅ Done | `test/e2e/realPlaywright.test.ts`, `test/integration/generateTestReport.test.ts` | `nativeReports.htmlReportPath` asli; Allure via fake CLI |
| S3-09 | Perjelas mode `generate_test_report`: locate atau generate | P2 | ✅ Done | `src/tools/generateTestReport.ts` | `mode` + `status` (`located`/`generated`/`not_found`/`setup_required`/`generation_failed`) |
| S3-10 | Periksa exit code dan stderr saat Allure generation | P1 | ✅ Done | `src/tools/generateTestReport.ts` | Test exit 2 + stderr tail, timeout, index tidak terbentuk |
| S3-11 | `recentSteps` dari `test.trace` (tanpa hook/fixture/route handler) | P1 | ✅ Done | `src/lib/browserDiagnostics.ts` | Unit + trace asli |
| S3-12 | `errorContextPath` (snapshot ARIA saat gagal) diekspos | P2 | ✅ Done | `src/lib/playwrightReport.ts` | Fixture asli + e2e |
| S3-13 | HTML reporter tidak membuka server/browser saat run MCP | P1 | ✅ Done | `src/lib/runConfig.ts` | `PW_TEST_HTML_REPORT_OPEN=never` |

### Acceptance criteria

- [x] Console error/warning berasal dari event Playwright, bukan dari scan stderr. Heuristik stderr sudah dihapus.
- [x] `pageerror`, failed request, dan HTTP 4xx/5xx tampil dengan URL/message yang relevan.
- [x] Diagnostics dibatasi agar tidak memenuhi response MCP.
- [x] Satu eksekusi menghasilkan JSON diagnostics sekaligus native HTML report.
- [x] Allure hanya dinyatakan berhasil jika command sukses dan `allure-report/index.html` benar-benar ada.
- [x] Tool mengembalikan status yang berbeda untuk report tidak ditemukan dan report generation gagal.

---

## Sprint 4 — Quality Scoring & Scaffold Quality — ✅ Done

**Keputusan:** scoring memakai TypeScript AST (`typescript` sudah ada di dependencies). Scaffold adalah **skeleton eksplisit**.

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S4-01 | Abaikan line/block comments pada scoring | P1 | ✅ Done | `src/lib/scoreContent.ts` | Comments-only test → semua hitungan 0 |
| S4-02 | Abaikan string/template content | P1 | ✅ Done | `src/lib/scoreContent.ts` | Strings/template test |
| S4-03 | TypeScript AST | P1 | ✅ Done | `src/lib/scoreContent.ts` | Multiline chains, `Promise.all`, `page.evaluate`, `test.skip(fn)` |
| S4-04 | Bedakan locator/action/assertion nyata dari TODO | P1 | ✅ Done | `src/lib/scoreContent.ts` | `scaffold: { skeleton, todoCount, fixmeTests }` |
| S4-05 | Tandai scaffold sebagai skeleton | P1 | ✅ Done | `src/tools/scaffoldTestDomain.ts` | `test.fixme` + `// @mcp-skeleton`; output `skeleton: true` + `nextSteps` |
| S4-06 | Semantic locator dan minimal web-first assertion | P1 | ✅ Done | template page/api | `heading` + `expectLoaded()`; `toBeOK()` di API helper |
| S4-07 | Perbaiki mock route dan error-flow template | P2 | ✅ Done | template mock/spec | Regex route mencakup `/api/v1/{feature}`, sub-path, dan query; `mockServerError(status)`; error-flow punya langkah assert |
| S4-08 | Generated files compile pada temporary Playwright project | P1 | ✅ Done | `test/integration/scaffoldSmoke.test.ts`, `test/e2e/realPlaywright.test.ts` | `transpileModule` di default suite; `tsc --strict` + Playwright run (`skipped`) di e2e |
| S4-09 | Factory unik lintas worker paralel | P2 | ✅ Done | template factory | Suffix acak di samping timestamp |

### Acceptance criteria

- [x] Komentar `// page.getByRole('button')` dan `// await expect(...)` tidak dihitung.
- [x] Scaffold kosong tidak memperoleh assertion density palsu (spec skeleton: 0 assertion).
- [x] Generated code dapat dikompilasi (`tsc --strict`, Playwright 1.62.1).
- [x] Dokumentasi menyatakan scaffold adalah skeleton.
- [x] Output memiliki marker/status yang dikenali tool dan model (`@mcp-skeleton`, `scaffold.skeleton`, `qualityScore.skeleton`).

---

## Sprint 5 — MCP Contract & Token Optimization — ✅ Done

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S5-01 | Definisikan output schema per tool | P2 | ✅ Done | `src/lib/outputSchemas.ts`, `src/index.ts` | Handshake test: setiap tool punya `outputSchema` |
| S5-02 | `structuredContent` dan human-readable summary | P2 | ✅ Done | `src/index.ts` | Teks = ringkasan satu baris + JSON compact, identik dengan `structuredContent` |
| S5-03 | Standarkan error `{ code, message, details }` | P1 | ✅ Done | `src/lib/toolErrors.ts` | `REPORT_ACCESS_DENIED` lewat MCP; `AMBIGUOUS_TEST` menyertakan kandidat |
| S5-04 | `run_playwright_test` ringkas secara default | P2 | ✅ Done | `src/lib/runOutput.ts` | `detail: "summary"`: hanya test yang perlu perhatian, maks. 5 failure |
| S5-05 | Detail besar dipindah ke `get_failure_details` / `detail: "full"` | P2 | ✅ Done | `src/lib/runOutput.ts`, `src/tools/getFailureDetails.ts` | stdout/stderr mentah dan attempts hanya di `full` |
| S5-06 | Batasi warnings, logs, traces, dan result arrays | P2 | ✅ Done | `src/lib/runOutput.ts` | Suite 300 test/100 gagal tetap ≤ 6.000 karakter |
| S5-07 | Opsi detail level | P2 | ✅ Done | input schema `detail` | Test summary vs full |
| S5-08 | Path artefak relatif terhadap `projectRoot` di output run | P2 | ✅ Done | `src/tools/runPlaywrightTest.ts` | e2e; `get_failure_details` tetap absolut |

### Budget yang terdokumentasi (diukur, bukan instruksi prompt)

| Output | Batas keras | Hasil terukur |
|---|---|---|
| `run_playwright_test` summary | 6.000 karakter JSON (≈ 1.500 token) | run asli, 2 project × 2 test, 2 gagal: ≈ 3.500 karakter (≈ 900 token) |
| `run_playwright_test` full | 100.000 karakter | suite 300 test lolos |
| `get_failure_details` | error message 4.000 karakter, call log 2.000 | — |

Saat batas tercapai, `fitToBudget` membuang detail paling tidak penting lebih dulu: warning kualitas, lalu daftar test (dipangkas setengah per langkah), lalu meringkas setiap failure, baru kemudian membuang failure. Status, counts, runner error, dan path artefak tidak pernah dibuang.

---

## Sprint 6 — Config Audit, Documentation & Release Readiness — ✅ Done (S6-08 Deferred)

| ID | Task | Severity | Status | Related files | Verification |
|---|---|---:|---|---|---|
| S6-01 | Perluas audit reporter HTML/JSON/Allure | P2 | ✅ Done | `src/lib/configAnalysis.ts`, `src/tools/checkPlaywrightConfig.ts` | `reporters: { detected, html, json, allure, determinable }` |
| S6-02 | Audit retries, workers, trace, screenshot, video, forbidOnly, fullyParallel | P2 | ✅ Done | idem | `defineConfig`, `module.exports`, variabel dalam file yang sama, `projects[].use`, spread |
| S6-03 | Dokumentasikan batasan heuristik config | P2 | ✅ Done | README, `limitations` di output | Nilai runtime = `expression`; spread/import dilaporkan; fallback `text_scan` diberi label |
| S6-04 | Selaraskan `RESEARCH_CONTEXT.md` dengan tool catalog aktual | P2 | ✅ Done | `docs/RESEARCH_CONTEXT.md` | Catatan status di awal dokumen (file ini di-ignore git) |
| S6-05 | Status tool lama: removed | P2 | ✅ Done | `CHANGELOG.md` | Decision log |
| S6-06 | Sinkronkan versi package dan lockfile | P2 | ✅ Done | `package.json`, `package-lock.json` | `npm run check:package`; versi server dibaca dari `package.json` |
| S6-07 | Bersihkan whitespace | P2 | ✅ Done | repository | `git diff --check` + cek file untracked (trailing space, newline akhir) |
| S6-08 | CI gate untuk build, test, dan package validation | P2 | 📝 Deferred | — | Ditunda atas keputusan owner (belum ingin CI/CD). Gate dijalankan manual dengan perintah di §9 |
| S6-09 | `npm audit --omit=dev` bersih | P1 | ✅ Done | `package.json`, `package-lock.json` | `npm audit fix` (semver-compatible; SDK 1.30.0 → 1.32.1) + hapus `fast-glob`/`diff` → 0 vulnerabilities |
| S6-10 | `npm run build` membersihkan `dist/` | P1 | ✅ Done | `package.json` | `npm pack --dry-run`: 31 file, tanpa modul basi |

### Acceptance criteria

- [x] Dokumentasi tidak menyatakan tool tersedia jika tool tidak terdaftar.
- [x] Config audit menjelaskan reporter yang terdeteksi secara eksplisit.
- [x] Versi root package dan lockfile konsisten.
- [x] `npm run build`, `npm test`, dan `git diff --check` berhasil.
- [x] Tidak ada unresolved P0/P1 issue.

---

## 5. Test matrix minimum

| Domain | Cases | Status |
|---|---|---|
| Path validation | Valid, empty, duplicate, separator, `..`, quote, backtick, newline, symlink, > 64 karakter | ✅ |
| Report access | In-root, missing, malformed, outside-root, symlink, terlalu besar, report runner yang sudah dirotasi | ✅ |
| Runner exit | Exit 0, exit 1, spawn error, signal, timeout, AbortSignal | ✅ |
| Playwright report | Passed, failed, skipped, timedOut, interrupted, flaky, empty suite, report.errors, report asli 1.62 | ✅ |
| Retry artifacts | Attachment di retry pertama dan terakhir; diagnostics dari attempt yang gagal | ✅ |
| Browser diagnostics | Console error/warning, pageerror, request failed, HTTP 500, batas, arsip korup | ✅ |
| Reporter | Wrapper TS/MTS/CJS/ESM, fallback tanpa config, wrapper basi, HTML asli | ✅ |
| Scoring | Comments-only, strings-only, multiline, floating action, browser callback, skeleton | ✅ |
| Scaffolding | Struktur file, compile `--strict`, run asli → skipped, overwrite tidak menimpa support | ✅ |
| Config audit | Literal, expression, spread, `projects[].use`, CJS, reporter, fallback text scan | ✅ |
| Prerequisites | Workspace, stray parent, outdated/incomplete browser, channel, revision override | ✅ |
| MCP contract | Output schema semua tool, structuredContent, error shape, shutdown saat stdin ditutup | ✅ |
| Token budget | Suite kecil (asli) dan besar (300 test) | ✅ |
| Release | Build, test, package metadata, audit, pack, diff check | ✅ (manual, lokal) |

---

## 6. Release gates

- [x] Semua P0 selesai.
- [x] Tidak ada path traversal atau arbitrary report read yang dapat direproduksi.
- [x] Exit code, report errors, timeout, cancellation, dan interrupted state diuji.
- [x] Browser diagnostics memakai instrumentation aktual (trace + fixture), dan klaim dokumentasi sudah disesuaikan.
- [x] Reporter behavior JSON/HTML diverifikasi pada temporary project dengan Playwright asli; Allure via fake CLI.
- [x] Scoring tidak menghitung komentar/TODO sebagai source nyata.
- [x] Generated scaffold dapat dikompilasi dan status skeleton terdokumentasi.
- [x] `npm test` menjalankan regression suite.
- [x] MCP output schemas dan error contract tervalidasi.
- [x] Default payload memiliki batas ukuran yang terdokumentasi.
- [x] Dokumentasi tool catalog konsisten.
- [x] Versi package metadata konsisten.
- [x] `npm run build` berhasil.
- [x] `npm test` berhasil.
- [x] `git diff --check` berhasil.
- [x] Lisensi konsisten (MIT).
- [x] Versi rilis ditetapkan: 0.2.0.

### Verification log (2026-10-07)

Dijalankan dari `/home/baramubarok/Development/Project/Personal/MCP/playwright-generate-mcp`:

| Command | Hasil |
|---|---|
| `npm run build` | PASS |
| `npm test` | PASS — 73 test: 71 pass, 0 fail, 2 skip (suite e2e opt-in) |
| `npm run test:unit` | PASS — 46 test |
| `npm run test:integration` | PASS — 25 test |
| `PW_MCP_REAL_PLAYWRIGHT_WORKSPACE=<lab> npm run test:e2e` | PASS — 2/2 (Playwright 1.62.1, Chromium build 1234) |
| `npm run check:package` | PASS — versi 0.1.0-alpha konsisten |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |
| `npm pack --dry-run` | PASS — 31 file |
| `git diff --check` | PASS |

---

## 7. Decision log

| Date | Decision | Status | Impact |
|---|---|---|---|
| 2026-09-03 | `fixing.md` menjadi tracker perbaikan terpisah dari roadmap v0.2 | Accepted | Roadmap tetap historis/strategis |
| 2026-09-03 | Security dan runner reliability dikerjakan sebelum visual reporting | Accepted | Mencegah report yang rapi tetapi salah |
| 2026-09-03 | Runner memakai local Playwright CLI dari preflight; tidak memakai bare `npx` | Accepted | Mencegah instalasi implisit |
| 2026-09-03 | Timeout default 120 s, range 100 ms–900 s | Accepted | Mencegah hang |
| 2026-10-07 | Scaffold = **skeleton eksplisit** (`test.fixme` + `@mcp-skeleton`), bukan contoh executable | Accepted | Contoh executable tidak bisa punya assertion bermakna untuk aplikasi yang belum diketahui; `fixme` membuat runner melapor `skipped`, bukan pass palsu |
| 2026-10-07 | Tool lama `read_file`, `list_files`, `write_test_file` **dihapus** tanpa shim kompatibilitas | Accepted | Versi masih alpha; client MCP sudah punya file access; dicatat di CHANGELOG |
| 2026-10-07 | Strategi reporter: **wrapper config sementara** di samping config proyek; `--reporter=json` hanya fallback | Accepted | `--reporter` selalu mengganti reporter config dan tidak ada env var untuk menambahkan reporter; wrapper di direktori yang sama menjaga resolusi path relatif |
| 2026-10-07 | Diagnostics browser dari **trace.zip + fixture scaffold**; heuristik stderr dihapus | Accepted | Reporter tidak bisa mengakses `page`; trace bekerja untuk test apa pun dengan trace aktif |
| 2026-10-07 | `testId` = `spec.id:projectId`, fallback posisi untuk report non-Playwright | Accepted | Format ID berubah dibanding sebelumnya (report lama tetap memakai fallback yang sama) |
| 2026-10-07 | Package di workspace root diterima; dari parent non-workspace ditolak | Accepted | Monorepo bisa dijalankan tanpa menurunkan guard |
| 2026-10-07 | Summary default dibatasi 6.000 karakter; path relatif terhadap `projectRoot` | Accepted | Kontrak output berubah: `tests` di summary hanya berisi test yang tidak pass; `runner.stdout/stderr` hanya ada di `full` |
| 2026-10-07 | Lisensi diseragamkan ke MIT (sebelumnya `package.json` ISC, README MIT) | Accepted | File `LICENSE` ditambahkan; ikut ter-publish ke npm |
| 2026-10-07 | CI/CD belum ditambahkan; workflow GitHub Actions yang sempat dibuat dihapus | Accepted | Release gate dijalankan manual; S6-08 Deferred |
| 2026-10-07 | `npm audit fix` (semver-compatible) + hapus `fast-glob`/`diff` | Accepted | SDK MCP naik ke 1.32.1 (dalam `^1.30.0`); seluruh test lulus |

---

## 8. Sisa pekerjaan & keputusan yang dibutuhkan

| Item | Jenis | Catatan |
|---|---|---|
| Versi rilis | ✅ Selesai | 0.2.0 di `package.json` dan `package-lock.json`; versi server MCP ikut otomatis |
| Lisensi | ✅ Selesai | MIT: `package.json`, `package-lock.json`, file `LICENSE`, dan README sudah konsisten |
| CI/CD | Deferred | Belum ditambahkan atas keputusan owner. Bila nanti diperlukan: `npm ci`, `npm run build`, `npm test`, `npm run check:package`, `npm audit --omit=dev`, `npm pack --dry-run`, plus job opsional `test:e2e` dengan `PW_MCP_REAL_PLAYWRIGHT_WORKSPACE` |
| `docs/adjustment-mcp-3.md` | Hygiene | Roadmap acuan ini tidak di-track git (`docs/*` di-ignore); `RESEARCH_CONTEXT.md` juga tidak |

### Risiko yang diketahui (diterima untuk v0.2)

- **Format trace** adalah format internal Playwright. Parser bersifat best-effort, kegagalan baca tidak menggagalkan tool, dan hanya divalidasi pada 1.62.1. Fixture diagnostics tetap berfungsi tanpa trace.
- **Wrapper config** muncul sesaat di direktori config proyek, dan watcher atau linter mungkin melihatnya. File dihapus setelah setiap run; sisa dari proses yang mati paksa dibersihkan pada run berikutnya.
- **Windows** belum diuji. Tidak ada kill process-group (hanya `child.kill`), dan shim `.cmd` Allure tidak dijalankan lewat shell.
- **Fixture diagnostics** bergantung pada `page`, jadi test domain yang hanya memakai `request` tetap membuka halaman.
- **Allure 2** (`allure-commandline`, butuh Java) hanya diuji dengan fake CLI.
- **Test runner** butuh Node 22+ karena memakai glob di `node --test`; runtime server sendiri tidak memakai fitur Node 22.

---

## 9. Cara memperbarui tracker

1. Ubah status task dari `⬜ Todo` ke `🔄 In Progress`.
2. Catat file yang berubah dan test yang ditambahkan pada PR/commit.
3. Ubah ke `✅ Done` hanya setelah acceptance criteria dan verification command lulus.
4. Jika ada keputusan arsitektur, tambahkan baris di **Decision log**.
5. Jika task ditunda, gunakan `📝 Deferred` dan tulis alasan serta target release.

### Verification command baseline

```bash
npm run build
npm test
npm run check:package
npm audit --omit=dev
git diff --check
# opsional, Playwright asli:
PW_MCP_REAL_PLAYWRIGHT_WORKSPACE=/path/to/pw-lab npm run test:e2e
```
