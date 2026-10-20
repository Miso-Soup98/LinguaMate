const LM_FREQ_EN = new Set(
  (
    "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is was are been has had were said did been than its over such through our being where much before move right too means old any same tell boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should america world high every near add food between own below country plant last school father keep tree never start city earth eye light thought head under story saw left don't few while along might close something seem next hard open example begin life always those both paper together got group often run important until children side feet car mile night walk white sea began grow took river four carry state once book hear stop without second later miss idea enough eat face watch far indian real almost let above girl sometimes mountains cut young talk soon list song being leave family it's body music color stand sun questions fish area mark dog horse birds problem complete room knew since ever piece told usually didn't friends easy heard order red door sure become top ship across today during short better best however low hours black products happened whole measure remember early waves reached listen table travel west lay against pattern slow center love person money serve appear road map science rule govern pull cold notice voice fall power town fine certain fly unit cry dark machine note wait plan figure star box noun field rest correct able pound done beauty drive stood contain front teach week final gave green oh quick develop sleep warm free minute strong special mind behind clear tail produce fact street inch lot nothing course stay wheel full force blue object decide surface deep moon island foot system busy test record boat common gold plane instead dry wonder laugh thousand ago ran check game shape equate hot miss brought heat snow bed bring sit perhaps fill east weight language among"
  ).split(/\s+/)
);

const LM_FREQ_ZH = new Set(
  "的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无长知世高正话如然手又已公"
    .split("")
    .filter(Boolean)
);

function lmNormalizeWord(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function lmIsCommonWord(word, lang) {
  const clean = lmNormalizeWord(word);
  if (!clean) return true;
  if ((lang || "").startsWith("zh")) return LM_FREQ_ZH.has(clean);
  if (lang === "en") return LM_FREQ_EN.has(clean);
  return clean.length <= 3;
}
