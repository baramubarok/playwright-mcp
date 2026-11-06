# NPM Publishing Guide

## 📋 Prerequisites

- [x] npm login done (`npm whoami` to verify)
- [x] package.json properly configured
- [x] Build passes: `npm run build`
- [x] Tests pass: `npm test`
- [x] Version updated in package.json
- [x] CHANGELOG.md updated with release notes
- [x] All changes committed to main branch

## 🚀 Publishing Flow

### Option 1: Manual Publishing (Local)

If you want to publish directly from your machine:

```bash
# 1. Verify you're logged in
npm whoami

# 2. Build the project
npm run build

# 3. Run tests to ensure everything works
npm test

# 4. Update version in package.json (e.g., from 0.2.0 to 0.3.0)
npm version patch   # or minor, major
# This will:
# - Update version in package.json
# - Create git tag automatically
# - Commit the change

# 5. Publish to NPM
npm publish --provenance

# 6. Push tags to GitHub
git push origin main --tags
```

### Option 2: Automated Publishing (CI/CD) ✨ RECOMMENDED

Using GitHub Actions (already configured):

```bash
# 1. Make sure your changes are committed
git add .
git commit -m "feat: your feature description"

# 2. Create and push a tag
#    This will automatically trigger the CI/CD workflow
npm version patch   # Updates package.json and creates tag
git push origin main --tags

# Or manually create tag:
git tag -a v0.3.0 -m "Release version 0.3.0"
git push origin v0.3.0
```

The GitHub Actions workflow will:
1. ✅ Checkout your code
2. ✅ Setup Node.js 20
3. ✅ Install dependencies
4. ✅ Build the project
5. ✅ Run tests
6. ✅ Publish to NPM with provenance
7. ✅ Create GitHub Release

## 🔐 Setup NPM Token in GitHub

To allow GitHub Actions to publish to NPM:

1. **Get your NPM token:**
   - Go to https://www.npmjs.com/settings/~/tokens
   - Create a new "Automation" token (for CI/CD)
   - Copy the token

2. **Add to GitHub Secrets:**
   - Go to: https://github.com/baramubarok/playwright-mcp/settings/secrets/actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Paste your NPM automation token
   - Click "Add secret"

## 📊 Version Management

Semantic Versioning (MAJOR.MINOR.PATCH):

```bash
npm version patch   # 0.2.0 → 0.2.1 (bug fixes)
npm version minor   # 0.2.0 → 0.3.0 (new features)
npm version major   # 0.2.0 → 1.0.0 (breaking changes)
```

## 📝 Checklist Before Publishing

- [ ] Update version in `package.json`
- [ ] Update `CHANGELOG.md` with release notes
- [ ] Commit all changes
- [ ] Build passes: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] No uncommitted changes: `git status`
- [ ] Create git tag: `git tag -a v0.x.x -m "Release version 0.x.x"`
- [ ] Push tag: `git push origin v0.x.x`
- [ ] Verify publication on: https://www.npmjs.com/package/playwright-generate-mcp

## 🔍 Verify Package

After publishing, verify it's available:

```bash
npm view playwright-generate-mcp
npm info playwright-generate-mcp
```

Install from published package:

```bash
npm install playwright-generate-mcp@latest
```

## 🐛 Troubleshooting

### "npm ERR! 403 Forbidden"
- Token might be expired or revoked
- Create new token at https://www.npmjs.com/settings/~/tokens
- Update GitHub secret

### "npm ERR! 404 Not Found"
- Ensure package name is unique
- Check it's not a private package
- Verify registry: `npm config get registry`

### "Tests fail in CI but pass locally"
- Environment differences
- Missing NODE_ENV setup
- Run: `npm ci` instead of `npm install`

## 📚 Additional Resources

- [NPM Publishing Docs](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [GitHub Actions Setup](https://github.com/actions/setup-node)
- [NPM Provenance](https://docs.npmjs.com/generating-provenance-statements)
