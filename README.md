# LinkedIn Role Fit Checker

A small userscript that adds a **"Check Suitability"** button to LinkedIn job listings.  
With one click, it extracts the job title, location, and full job description and sends it to a pre-configured ChatGPT Project for evaluation.

---

## ✨ Features

- Adds a **Check Suitability** button to LinkedIn job pages
- Extracts:
  - Job title
  - Job location
  - Full job description
- Opens your configured ChatGPT Project automatically
- Pastes job details into the chat input
- Does **not** auto-send messages (you stay in control)
- Works with LinkedIn SPA navigation

---

## ⚠️ Disclaimer

`IMPORTANT:
This script modifies LinkedIn’s page locally in your browser and, while no automation or external data transmission is performed, its use could theoretically be detectable by LinkedIn and is therefore used at your own risk.`

- This is a **fun personal side project** built during free time. It's not production software  
- Provided **as-is**   
- LinkedIn or ChatGPT UI updates may break functionality  
- Not affiliated with LinkedIn or OpenAI  

---

## 🧪 Tested Environment

- ✅ Google Chrome  
- ✅ Tampermonkey  
- ⚠️ Other browsers or userscript managers are not officially tested  

---

## 💰 ChatGPT Subscription Requirement

This script relies on **ChatGPT Projects**, which currently require a **paid ChatGPT subscription**.

---

## 🔒 Compatibility Notes

This script may conflict with:

- Clipboard protection extensions
- Script blockers
- Privacy/security browser extensions
- Corporate browser restrictions

---

# 📦 Installation

## Step 1 — Install Tampermonkey

Install Tampermonkey from:

👉 https://www.tampermonkey.net/

Restart your browser if prompted.

---

## Step 2 — Install This Script

Click the install link below:

👉 **[Install LinkedIn Role Fit Checker](https://raw.githubusercontent.com/gpanag93/linkedin2chatgpt/main/linkedin-role-fit-checker.user.js)**

Tampermonkey should automatically open the installation screen.

Click **Install**.

---

## Step 3 — Confirm Installation

Open Tampermonkey and verify the script is enabled.

---

# 🤖 ChatGPT Project Setup (Required)

Before using the script, you must create a corresponding ChatGPT Project.

---

## Step 1 — Create a ChatGPT Project

1. Open ChatGPT  
2. Create a new Project  
3. Name it anything you like  

---

## Step 2 — Initialize The Project

Paste this into the **first message** of your project (feel free to adjust):

```
In this project, you will act as a structured job suitability assessor.

Your goal is to evaluate how well a job role matches my profile, experience, strengths, risks, and growth potential. I will first provide information about myself in this conversation. After that, every new chat in this project will contain a job title and description for evaluation.

For each role, you should:
- Assess overall suitability
- Identify strengths that match the role
- Identify gaps or risks
- Evaluate long-term growth alignment
- Provide a realistic recommendation (apply, consider, or avoid)
- Highlight any red flags in the job description

Be honest, pragmatic, and evidence-based. Avoid generic encouragement. Prioritize realistic career outcomes.

About me:
- 25 years of bicycle experience
- Fluent in Dothraki
- Master's degree in astrology

Before we begin evaluating roles, ask any clarifying questions that would help you better assess my suitability. Focus on questions that improve accuracy and long-term career alignment, as well as practical information about myself relevant to job search.
```

Answer any follow-up questions ChatGPT asks.

Your project is now ready.

---

# 🚀 Usage

1. Open a LinkedIn job listing  
2. Click **Check Suitability** next to the job title  
3. On first use, paste your ChatGPT Project URL when prompted  
4. The script will:
   - Open your ChatGPT Project
   - Paste the job details into the chat input
5. Review and press **Send** manually

---

# ⚙️ Change ChatGPT Project URL

Hold **Shift** while clicking **Check Suitability** to update the configured project.

---

# 🔐 Privacy

- No external servers are used  
- All configuration is stored locally via Tampermonkey  
- Only job data visible in LinkedIn is extracted  

---

# 🐛 Known Limitations

- May break if LinkedIn or ChatGPT change UI structure  
- Requires manual message submission  
- Only works on LinkedIn job pages  

---

# 🙌 Contributions

Pull requests, bug reports, and suggestions are welcome.

---

# ☕ Final Note

Built as a small productivity helper while job searching.  
If it saves you time — awesome.  
If it breaks — also expected 🙂

<p align="center">
  <a href="https://www.tampermonkey.net/donate.php" target="_blank">
    <img src="https://www.tampermonkey.net/images/icon48.png" alt="Tampermonkey Logo" />
  </a>
</p>

<p align="center">
  <a href="https://www.tampermonkey.net/donate.php" target="_blank">
    <strong>Consider supporting Tampermonkey for their awesome tool ❤️</strong>
  </a>
</p>


