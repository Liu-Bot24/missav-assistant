(() => {
  "use strict";

  const groups = Object.freeze([
    Object.freeze({
      id: "duration-4h-plus",
      label: "4 小时以上",
      description: "按影片时长判断（至少 4:00:00）",
      minDurationSeconds: 4 * 60 * 60,
      aliases: Object.freeze([])
    }),
    Object.freeze({
      id: "gender-diverse",
      label: "伪娘 / 变性 / 异装相关",
      description: "组合匹配站内多语言类型",
      aliases: Object.freeze([
        "人妖", "偽娘", "伪娘", "變性者", "变性者", "異裝男", "异装男",
        "女装・男の娘", "男の娘", "ニューハーフ", "shemale", "transsexual", "transgender"
      ])
    })
  ]);

  const seedTypes = Object.freeze([
    "3P・4P", "4K", "M女", "VR", "アナルセックス（男の娘）", "イラマチオ",
    "その他フェチ", "デビュー作品", "ニューハーフ", "ハーレム", "ハイビジョン",
    "中出し", "乱交", "制服", "単体作品", "女装・男の娘", "女子校生", "巨乳",
    "巨尻", "恋物癖", "監禁", "競泳・スクール水着", "素人", "美少女", "辱め",
    "顔射", "妄想族", "独占配信", "淫乱・ハード系",
    "高清", "獨家", "中出", "單體作品", "人妻", "熟女", "口交", "多人運動",
    "騎乘", "薄格", "痴女", "女高中生", "潮吹", "苗條", "自拍",
    "合集", "乳交", "美乳", "戀物癖", "NTR", "企劃", "亂倫", "搭訕", "顏射",
    "淫亂", "偷拍", "劇情", "自慰", "手淫", "姐姐", "羞辱"
  ]);

  // Site labels checked against /cn/genres, /ja/genres and /genres on 2026-09-07.
  // Keep metadata values as aliases; only the display name is Chinese.
  const localizedTypes = Object.freeze([
    ["高清","ハイビジョン","高清"],
    ["独家","独占配信","独家","獨家"],
    ["中出","中出し","中出"],
    ["单体作品","単体作品","单体作品","單體作品"],
    ["巨乳","巨乳"],
    ["人妻","人妻・主婦","人妻"],
    ["熟女","熟女"],
    ["素人","素人"],
    ["美少女","美少女"],
    ["口交","フェラ","口交"],
    ["多人运动","3P・4P","多人运动","多人運動"],
    ["骑乘","騎乗位","骑乘","騎乘"],
    ["薄格","デジモ","薄格"],
    ["痴女","痴女"],
    ["4小时以上","4時間以上作品","4小时以上","4小時以上"],
    ["女高中生","女子校生","女高中生"],
    ["潮吹","潮吹き","潮吹"],
    ["苗条","スレンダー","苗条","苗條"],
    ["自拍","ハメ撮り","自拍"],
    ["乳交","パイズリ","乳交"],
    ["合集","ベスト・総集編","合集"],
    ["美乳","美乳"],
    ["NTR","寝取り・寝取られ・NTR","NTR"],
    ["恋物癖","その他フェチ","恋物癖","戀物癖"],
    ["企划","企画","企划","企劃"],
    ["乱伦","近親相姦","乱伦","亂倫"],
    ["搭讪","ナンパ","搭讪","搭訕"],
    ["颜射","顔射","颜射","顏射"],
    ["淫乱","淫乱・ハード系","淫乱","淫亂"],
    ["偷拍","盗撮・のぞき","偷拍"],
    ["4K","4K"],
    ["剧情","ドラマ","剧情","劇情"],
    ["自慰","オナニー","自慰"],
    ["手淫","手コキ","手淫"],
    ["姐姐","お姉さん","姐姐"],
    ["纪录片","ドキュメンタリー","纪录片","紀錄片"],
    ["羞辱","辱め","羞辱"],
    ["拘束","拘束"],
    ["角色扮演","コスプレ","角色扮演"],
    ["不伦","不倫","不伦"],
    ["OL","OL"],
    ["妄想","妄想族","妄想"],
    ["制服","制服"],
    ["辣妹","ギャル","辣妹"],
    ["女同性恋","レズ","女同性恋","女同性戀"],
    ["羞耻","羞恥","羞耻"],
    ["女大学生","女子大生","女大学生","女大學生"],
    ["舔阴","クンニ","舔阴","舔陰"],
    ["剃毛","パイパン","剃毛"],
    ["按摩棒","電マ","按摩棒","バイブ"],
    ["指插","指マン","指插"],
    ["大屁股","巨尻","大屁股"],
    ["肛门","アナル","肛门","肛門"],
    ["主观视角","主観","主观视角","主觀視角"],
    ["SM","SM"],
    ["乱交","乱交","亂交"],
    ["仅送货","配信専用","仅送货","僅送貨"],
    ["出道作","デビュー作品","出道作"],
    ["屁股偏好","尻フェチ","屁股偏好"],
    ["风俗娘","キャバ嬢・風俗嬢","风俗娘","風俗娘"],
    ["校服","学生服","校服"],
    ["小只马","ミニ系","小只马","小隻馬","小柄"],
    ["玩具","おもちゃ","玩具"],
    ["强制口交","イラマチオ","强制口交","強制口交"],
    ["各种职业","職業色々","各种职业","各種職業"],
    ["丝袜","パンスト・タイツ","丝袜","絲襪"],
    ["母亲","お母さん","母亲","母親"],
    ["淫语","淫語","淫语"],
    ["野外露出","野外・露出","野外露出"],
    ["放尿","放尿・お漏らし","放尿"],
    ["按摩","マッサージ・リフレ","按摩"],
    ["全高清 (FHD)","フルハイビジョン(FHD)","全高清 (FHD)"],
    ["接吻","キス・接吻","接吻"],
    ["女教师","女教師","女教师"],
    ["按摩油","ローション・オイル","按摩油"],
    ["内衣","ランジェリー","内衣","內衣"],
    ["吞精","ごっくん","吞精"],
    ["姐妹","姉・妹","姐妹"],
    ["贫乳","貧乳・微乳","贫乳","貧乳"],
    ["泳装","水着","泳装","泳裝","競泳・スクール水着"],
    ["多人颜射","ぶっかけ","多人颜射","多人顏射"],
    ["水手服","セーラー服","水手服"],
    ["年轻妻子","若妻・幼妻","年轻妻子","年輕妻子"],
    ["护士","看護婦・ナース","护士","護士"],
    ["和服","和服・浴衣","和服"],
    ["回春按摩","エステ","回春按摩"],
    ["超薄格","ギリモザ","超薄格"],
    ["69","シックスナイン","69"],
    ["胖妹","ぽっちゃり","胖妹"],
    ["极限高潮","アクメ・オーガズム","极限高潮","極限高潮"],
    ["短裙","パンチラ","短裙"],
    ["好屁股","美尻","好屁股"],
    ["恋足","脚フェチ","恋足","戀足"],
    ["捆绑","ボンテージ","捆绑","捆綁","縛り・緊縛"],
    ["巨乳偏好","巨乳フェチ","巨乳偏好"],
    ["处女","童貞","处女","處女","処女"],
    ["投稿","投稿"],
    ["大特写","局部アップ","大特写","大特寫"],
    ["M男","M男"],
    ["眼镜娘","めがね","眼镜娘","眼鏡娘"],
    ["温泉","温泉","溫泉"],
    ["爆汗","汗だく","爆汗"],
    ["偶像艺人","アイドル・芸能人","偶像艺人","偶像藝人"],
    ["巨根","デカチン・巨根","巨根"],
    ["高妹","長身","高妹"],
    ["媚药","ドラッグ","媚药","媚藥"],
    ["颜面骑乘","顔面騎乗","颜面骑乘","顏面騎乘"],
    ["运动服","体操着・ブルマ","运动服","運動服"],
    ["女仆","メイド","女仆","女僕"],
    ["女同性恋接吻","レズキス","女同性恋接吻","女同性戀接吻"],
    ["夫妻","カップル","夫妻"],
    ["脚交","足コキ","脚交","腳交"],
    ["监禁","監禁","监禁"],
    ["迷你裙","ミニスカ","迷你裙"],
    ["震蛋","ローター","震蛋"],
    ["义母","義母","义母"],
    ["皮肤白","色白","皮肤白","皮膚白"],
    ["肛交","アナルセックス","肛交"],
    ["艾曼纽","エマニエル","艾曼纽","艾曼紐"],
    ["恶作剧","イタズラ","恶作剧","惡作劇"],
    ["美腿","美脚","美腿"],
    ["超乳","超乳"],
    ["广告偶像","イメージビデオ","广告偶像","廣告偶像"],
    ["鬼畜","鬼畜"],
    ["女优合集","女優ベスト・総集編","女优合集","女優合集"],
    ["格斗","アクション・格闘","格斗","格鬥"],
    ["特摄","特撮","特摄","特攝"],
    ["后入","バック","后入","後入"],
    ["黑人男优","黒人男優","黑人男优","黑人男優"],
    ["女战士","女戦士","女战士","女戰士"],
    ["变性者","ニューハーフ","变性者","變性者"],
    ["家庭教师","家庭教師","家庭教师"],
    ["M女","M女"],
    ["后宫","ハーレム","后宫","後宮"],
    ["情色写真","着エロ","情色写真","情色寫真"],
    ["拷问","拷問","拷问"],
    ["多个故事","複数話","多个故事","多個故事"],
    ["性感","セクシー","性感"],
    ["未亡人","未亡人"],
    ["清纯","清楚","清纯","清純"],
    ["黑发","黒髪","黑发","黑髮"],
    ["即时插入","即ハメ","即时插入","即時插入"],
    ["校园故事","学園もの","校园故事","校園故事"],
    ["恋爱","恋愛","恋爱","戀愛"],
    ["体操服","レオタード","体操服","體操服"],
    ["3P、4P","3P、4P"],
    ["伪娘","女装・男の娘","伪娘","偽娘"],
    ["婊子","ビッチ","婊子"],
    ["灌肠","浣腸","灌肠","灌腸"],
    ["车震","カーセックス","车震","車震"],
    ["女医生","女医","女医生","女醫生"],
    ["泡泡浴","ヘルス・ソープ","泡泡浴"],
    ["空姐","スチュワーデス","空姐"],
    ["女性向","女性向け","女性向"],
    ["白人","白人女優","白人"],
    ["大小姐","お嬢様・令嬢","大小姐"],
    ["女上司","女上司"],
    ["女搜查官","女捜査官","女搜查官"],
    ["体育","スポーツ","体育","體育"],
    ["舞蹈","ダンス","舞蹈"],
    ["格斗家","格闘家","格斗家","格鬥家"],
    ["感谢祭","ファン感謝・訪問","感谢祭","感謝祭"],
    ["外国女优","洋ピン・海外輸入","外国女优","外國女優"],
    ["古铜色","日焼け","古铜色","古銅色"],
    ["原创","原作コラボ","原创","原創"],
    ["最佳，综合","ベスト、総集編","最佳，综合","最佳，綜合"],
    ["VR","VR専用","VR"],
    ["只送货的业馀爱好者","配信専用素人","只送货的业馀爱好者","只送貨的業餘愛好者"],
    ["模特儿","モデル","模特儿","模特兒"],
    ["正太","ショタ","正太"],
    ["娃娃脸","童顔","娃娃脸","娃娃臉"],
    ["秘书","秘書","秘书"],
    ["三十","三十路","三十"],
    ["高品质 VR","ハイクオリティVR","高品质 VR","高品質 VR"],
    ["过膝袜","ニーソックス","过膝袜","過膝襪"],
    ["约会","デート","约会","約會"],
    ["母乳","母乳"],
    ["连身裙","ボディコン","连身裙","連身裙"],
    ["抓痒","くすぐり","抓痒","抓癢"],
    ["饮尿","飲尿","饮尿"],
    ["天堂电视","パラダイスTV","天堂电视","天堂電視"],
    ["女主播","女子アナ","女主播"],
    ["逆搭讪","逆ナン","逆搭讪","逆搭訕"],
    ["灯笼裤","ブルマ","灯笼裤","燈籠褲"],
    ["青梅竹马","幼なじみ","青梅竹马","青梅竹馬"],
    ["其他","その他","其他"],
    ["戴绿帽子","寝取り・寝取られ","戴绿帽子","戴綠帽子"],
    ["漂亮的胸部","素敵なおっぱい","漂亮的胸部"],
    ["美容按摩","エステ・マッサージ","美容按摩"],
    ["假阳具","ディルド","假阳具","假陽具"],
    ["异物插入","異物挿入","异物插入","異物插入"],
    ["下属或同事","部下・同僚","下属或同事","下屬或同事"],
    ["年轻的妻子","若妻","年轻的妻子","年輕的妻子"],
    ["孕妇","妊婦","孕妇","孕婦"],
    ["独立制片","インディーズ","独立制片","獨立制片"],
    ["兔女郎","バニーガール","兔女郎"],
    ["赛车女郎","キャンギャル","赛车女郎","賽車女郎"],
    ["侮辱","凌辱","侮辱"],
    ["肛交（异装男）","アナルセックス（男の娘）","肛交（异装男）","肛交（異裝男）"]
  ].map(([label, ...aliases]) => Object.freeze({ label, aliases: Object.freeze(aliases) })));

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim()
      .toLocaleLowerCase();
  }

  function groupRule(id) {
    return `group:${id}`;
  }

  function valueRule(value) {
    return `value:${encodeURIComponent(String(value))}`;
  }

  const typesByAlias = new Map();
  for (const type of localizedTypes) {
    for (const alias of type.aliases) {
      const key = normalize(alias);
      if (!typesByAlias.has(key)) typesByAlias.set(key, type);
    }
  }

  function canonicalValue(value) {
    return typesByAlias.get(normalize(value))?.aliases[0] ?? value;
  }

  function decodeValueRule(rule) {
    if (!String(rule).startsWith("value:")) return null;
    try {
      return decodeURIComponent(String(rule).slice(6));
    } catch {
      return null;
    }
  }

  function normalizeRule(rule) {
    const text = String(rule);
    const value = decodeValueRule(text);
    if (value !== null) {
      const key = normalize(value);
      if (["4小時以上", "4小时以上", "4時間以上", "4時間以上作品"].includes(key)) {
        return groupRule("duration-4h-plus");
      }
      return valueRule(canonicalValue(value));
    }

    if (text.startsWith("group:")) {
      return groups.some((group) => groupRule(group.id) === text) ? text : null;
    }

    return null;
  }

  function matches(rule, metadataValues, metadata = {}) {
    const normalizedRule = normalizeRule(rule);
    if (!normalizedRule) return false;

    const normalizedValues = (Array.isArray(metadataValues) ? metadataValues : [])
      .map((value) => normalize(canonicalValue(value)))
      .filter(Boolean);
    const value = decodeValueRule(normalizedRule);
    if (value !== null) {
      const normalizedValue = normalize(value);
      return normalizedValues.some((item) => item === normalizedValue);
    }

    if (normalizedRule.startsWith("group:")) {
      const group = groups.find((item) => item.id === normalizedRule.slice(6));
      if (!group) return false;
      if (Number.isFinite(group.minDurationSeconds)) {
        return Number(metadata?.duration) >= group.minDurationSeconds;
      }
      return group.aliases
        .map(normalize)
        .some((alias) => normalizedValues.some((item) => item.includes(alias)));
    }

    return false;
  }

  function options(discoveredTypes = []) {
    const seen = new Set();
    const values = [...seedTypes, ...discoveredTypes]
      .map((value) => String(canonicalValue(value)).trim())
      .filter((value) => {
        const key = normalize(value);
        if (["4小時以上", "4小时以上", "4時間以上", "4時間以上作品"].includes(key)) {
          return false;
        }
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => {
        const leftLabel = typesByAlias.get(normalize(left))?.label ?? left;
        const rightLabel = typesByAlias.get(normalize(right))?.label ?? right;
        return leftLabel.localeCompare(rightLabel, "zh-CN");
      });

    return [
      ...groups.map((group) => ({
        rule: groupRule(group.id),
        label: group.label,
        description: group.description,
        kind: "group"
      })),
      ...values.map((value) => ({
        rule: valueRule(value),
        label: typesByAlias.get(normalize(value))?.label ?? value,
        aliases: typesByAlias.get(normalize(value))?.aliases ?? [value],
        description: "站内类型",
        kind: "value"
      }))
    ];
  }

  globalThis.MissavGenreLibrary = Object.freeze({
    groups,
    seedTypes,
    normalize,
    groupRule,
    valueRule,
    decodeValueRule,
    normalizeRule,
    matches,
    options
  });
})();
