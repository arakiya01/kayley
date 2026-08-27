#!/bin/bash
# Kayley.app は署名（notarize）していないため、そのままだと
# macOSが「"Kayley.app" is damaged and can't be opened」という
# （実際には壊れていない）誤解を招く表示をすることがあります。
# このスクリプトは、その原因（ダウンロード時に付く隔離属性）を取り除いてから
# Kayleyを起動します。
cd "$(dirname "$0")"
echo "Kayleyを開けるようにしています…"
xattr -cr Kayley.app 2>/dev/null
echo "完了しました。Kayleyを起動します。"
open Kayley.app
sleep 1
