# NPM Publishing Guide

## 📋 Prerequisites

- [x] npm login done (`npm whoami` to verify)
- [x] 2FA enabled on NPM account (REQUIRED for promoting staged packages)
- [x] package.json properly configured
- [x] Build passes: `npm run build`
- [x] Tests pass: `npm test`
- [x] Version updated in package.json
- [x] CHANGELOG.md updated with release notes
- [x] All changes committed to main branch

## ⚠️ Important: NPM Token Changes (2FA Required)

As of January 2027, direct-publish tokens will be deprecated. We use a **staged publishing approach**:

1. **CI/CD stages the package** with a granular access token (stage-only)
2. **You manually promote** the staged package with 2FA enabled

This is more secure and aligns with NPM's new requirements.

## 🚀 Publishing Flow

### Option 1: Automated with Manual Promotion (CI/CD) ✨ RECOMMENDED

This is the workflow we set up:

```bash
# 1. Make sure your changes are committed
git add .
git commit -m "feat: your feature description"

# 2. Create and push a tag
npm version patch   # Updates package.json and creates tag (e.g., v0.2.1)
git push origin main --tags
```

The GitHub Actions workflow will automatically:
1. ✅ Checkout code
2. ✅ Setup Node.js 20
3. ✅ Install dependencies
4. ✅ Build the project
5. ✅ Run all tests
6. ✅ **Stage the package to NPM** with tag `staging`
7. ✅ Create GitHub Release with promotion instructions

**Then you promote locally with 2FA:**

```bash
# View staged package to verify
npm view playwright-generate-mcp@0.2.1

# Promote from staging to latest (requires 2FA when prompted)
npm dist-tag add playwright-generate-mcp@0.2.1 latest
npm dist-tag rm playwright-generate-mcp staging
```

### Option 2: Manual Publishing (Local)

If you want to publish directly from your machine:

```bash
# 1. Verify you're logged in
npm whoami

# 2. Build and test
npm run build
npm test

# 3. Update version
npm version patch

# 4. Stage the package
npm publish --tag staging

# 5. View and verify
npm view playwright-generate-mcp

# 6. Promote to latest with 2FA
npm dist-tag add playwright-generate-mcp@0.2.1 latest
npm dist-tag rm playwright-generate-mcp staging

# 7. Push tags to GitHub
git push origin main --tags
```

## 🔐 Setup NPM Token in GitHub (Automated CI/CD)

To allow GitHub Actions to stage packages to NPM:

1. **Create a "Stage Only" token:**
   - Go to https://www.npmjs.com/settings/~/tokens
   - Click "Generate New Token" → Choose **"Automation"**
   - Set **Permissions**: "Read and write (stage only)" ← IMPORTANT!
   - Set **Expiration**: 90 days or 1 year
   - Copy the token

2. **Add to GitHub Secrets:**
   - Go to: https://github.com/baramubarok/playwright-mcp/settings/secrets/actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Paste your automation token
   - Click "Add secret"

3. **Enable 2FA on NPM Account:**
   - Go to: https://www.npmjs.com/settings/~/auth-and-security
   - Enable "Two-Factor Authentication" with authenticator app or SMS
   - This is required to promote staged packages

## 📊 Version Management

Semantic Versioning (MAJOR.MINOR.PATCH):

```bash
npm version patch   # 0.2.0 → 0.2.1 (bug fixes)
npm version minor   # 0.2.0 → 0.3.0 (new features)
npm version major   # 0.2.0 → 1.0.0 (breaking changes)
```

## 📝 Complete Publish Checklist

### Before creating a tag:
- [ ] Update version in `package.json`
- [ ] Update `CHANGELOG.md` with release notes
- [ ] Commit all changes: `git commit -m "..."`
- [ ] Push to main: `git push origin main`
- [ ] Build passes: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] No uncommitted changes: `git status`

### Push the tag (triggers CI/CD):
- [ ] Create tag: `npm version patch` (or minor/major)
- [ ] Or manually: `git tag -a v0.x.x -m "Release version 0.x.x"`
- [ ] Push tag: `git push origin main --tags`
- [ ] Monitor: https://github.com/baramubarok/playwright-mcp/actions

### After CI/CD completes:
- [ ] Verify package was staged: `npm view playwright-generate-mcp`
- [ ] Should show `staging` dist-tag
- [ ] Promote with 2FA:
  ```bash
  npm dist-tag add playwright-generate-mcp@0.x.x latest
  npm dist-tag rm playwright-generate-mcp staging
  ```
- [ ] Verify on: https://www.npmjs.com/package/playwright-generate-mcp

## 🔍 Verify Package After Publishing

```bash
# View package info
npm view playwright-generate-mcp

# Check specific version
npm info playwright-generate-mcp@0.2.1

# Install latest version
npm install playwright-generate-mcp@latest

# Check which version is installed
npm ls playwright-generate-mcp
```

## 🔄 Promoting Staged Packages

If you need to promote a staged package later:

```bash
# List all dist-tags
npm view playwright-generate-mcp dist-tags

# Promote staging to latest
npm dist-tag add playwright-generate-mcp@VERSION latest

# Remove staging tag (cleanup)
npm dist-tag rm playwright-generate-mcp staging

# Or promote to a specific tag
npm dist-tag add playwright-generate-mcp@VERSION beta
```

## 🐛 Troubleshooting

### "npm ERR! 403 Forbidden"
- Token might be expired or revoked
- Create new token at https://www.npmjs.com/settings/~/tokens
- Update GitHub secret with new token

### "You need to enable 2FA to promote packages"
- Enable 2FA on NPM account: https://www.npmjs.com/settings/~/auth-and-security
- Use authenticator app (Microsoft Authenticator, Google Authenticator, etc.)
- Required for promoting staged packages

### "npm ERR! 404 Not Found"
- Ensure package name is unique
- Check it's not a private package
- Verify registry: `npm config get registry`

### "Package not found in staging"
- Ensure CI/CD workflow completed successfully
- Check GitHub Actions logs: https://github.com/baramubarok/playwright-mcp/actions
- Verify NPM_TOKEN has "stage only" permission

### Tests fail in CI but pass locally
- Environment differences
- Missing NODE_ENV setup
- Run: `npm ci` instead of `npm install`

## 📚 Additional Resources

- [NPM Publishing Docs](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [NPM 2FA Requirements](https://docs.npmjs.com/about-two-factor-authentication)
- [NPM Dist Tags](https://docs.npmjs.com/cli/v8/commands/npm-dist-tag)
- [GitHub Actions Setup](https://github.com/actions/setup-node)
- [NPM Provenance](https://docs.npmjs.com/generating-provenance-statements)

