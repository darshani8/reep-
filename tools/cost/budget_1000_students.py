"""Budget model for the board: 1,000 students, two 8-minute mock interviews a day.

Every unit price below is one of two things. Either it is what THIS account
(445363794125) was billed per unit on 2026-09-16, read from Cost Explorer with
RECORD_TYPE=Usage so the promotional credits are excluded, or it is the AWS price
list for ap-south-1 / ap-northeast-1 for an item the deployment does not buy yet
(marked "list"). Re-run it after changing an assumption;
docs/budget-1000-students-2026-09.md quotes its output verbatim.

    python tools/cost/budget_1000_students.py

Standard library only. Nothing here talks to AWS.
"""

FX = 96.0          # INR per USD, 2026-09-17
GST = 0.18         # charged on the net invoice
HOURS = 730        # billing hours in a month

# --- unit prices measured on this account, 2026-09-16 --------------------
FARGATE_VCPU_H, FARGATE_GB_H = 0.02383, 0.00261      # Fargate ARM64, Mumbai
TASK_H = 0.5 * FARGATE_VCPU_H + 1.0 * FARGATE_GB_H  # one 0.5 vCPU / 1 GB api task
NAT_H, NAT_GB = 0.056, 0.056                         # NAT gateway hour, GB processed
RDS_MICRO_MAZ_H = 0.042                              # db.t4g.micro Multi-AZ (running today)
RDS_SMALL_MAZ_H = 0.084                              # db.t4g.small Multi-AZ (list)
RDS_GP3_MAZ_GB_MO, RDS_BACKUP_GB_MO = 0.262, 0.095
ALB_H, LCU_H = 0.0239, 0.008
IPV4_H = 0.005
INTER_REGION_GB = 0.086                              # Mumbai -> Tokyo / Singapore
CF_TO_ORIGIN_GB = 0.16                               # CloudFront, India, viewer -> origin
CF_DTO_GB, CF_FREE_TB = 0.109, 1.0                   # CloudFront, India, after the free 1 TB (list)
CW_LOGS_GB = 0.67                                    # CloudWatch Logs ingestion, Mumbai (list)
EFS_STD_GB_MO, EFS_IA_GB_MO, EFS_IA_WRITE_GB = 0.33, 0.0272, 0.011   # list
S3_STD_GB_MO = 0.025                                                 # list
BACKUP_EFS_MUMBAI_GB_MO, BACKUP_EFS_SG_GB_MO, BACKUP_XREGION_GB = 0.055, 0.06, 0.106  # list
# Amazon Nova 2 Sonic in Tokyo, USD per million tokens, as billed
NOVA_IN, NOVA_OUT, NOVA_TIN, NOVA_TOUT = 3.63, 14.52, 0.396, 3.311
NOVA_US_IN, NOVA_US_OUT = 3.00, 12.00               # US-region list price, for the option below
# Amazon Nova Pro (APAC inference profile, Mumbai), as billed
PRO_IN, PRO_OUT = 0.94, 3.76

# --- today's fixed platform, USD per day, from the 2026-09-16 usage records --
TODAY = {
    "NAT gateway hours": 1.344,
    "NAT data processing (8 GB/day today)": 0.446,
    "RDS db.t4g.micro Multi-AZ": 1.008,
    "Fargate 2 x (0.5 vCPU, 1 GB) ARM64": 0.707,
    "ALB hours + LCU": 0.575,
    "CloudWatch metrics + alarms": 0.393,
    "Public IPv4 x 3": 0.36,
    "RDS storage gp3 20 GB Multi-AZ": 0.175,
    "WAF (ACL + 3 rules + requests)": 0.270,
    "RDS backups (Mumbai + Singapore)": 0.144,
    "Backup copy transfer to Singapore": 0.211,
    "Regional data transfer": 0.069,
    "Secrets Manager": 0.028,
    "S3 + ECR + EFS + SES + misc": 0.06,
    "AWS Backup vault storage (lumpy, ~$3.6/mo)": 0.12,
}
today_month = sum(TODAY.values()) * 30.4

# --- the load -------------------------------------------------------------
STUDENTS, PER_DAY, MINUTES = 1000, 2, 8.0
SECONDS = MINUTES * 60
TOKENS_PER_S = 25                       # AWS: Nova Sonic audio is 25 tokens per second
STUDENT_TALK = 0.45                     # share of the session the student is speaking
INTERVIEWER_TALK = 0.50                 # share billed as interviewer speech (generated ahead of playback)
# text tokens per interview scale with speech input, at the ratios measured 1-17 Sep
TEXT_IN_RATIO, TEXT_OUT_RATIO = 65176 / 24999, 16906 / 24999
AGENT_ASKS_PER_STUDENT_MONTH = 10       # REEP Agent questions (Nova Pro), an assumption
LOG_MB_PER_INTERVIEW = 0.5              # CloudWatch Logs written per interview, an assumption


def nova_per_interview(price_in=NOVA_IN, price_out=NOVA_OUT, bill_silence=False, interviewer=INTERVIEWER_TALK):
    tin = SECONDS * TOKENS_PER_S * (1.0 if bill_silence else STUDENT_TALK)
    tout = SECONDS * TOKENS_PER_S * interviewer
    text_in, text_out = tin * TEXT_IN_RATIO, tin * TEXT_OUT_RATIO
    return dict(speech_in=tin * price_in / 1e6, speech_out=tout * price_out / 1e6,
                text_in=text_in * NOVA_TIN / 1e6, text_out=text_out * NOVA_TOUT / 1e6,
                tokens=(tin, tout, text_in, text_out))


def network_per_interview(interviewer=INTERVIEWER_TALK):
    up_client = 48_000 * SECONDS / 1e9              # browser mic, 24 kHz PCM16, GB
    down_client = 48_000 * SECONDS * interviewer / 1e9
    up_tokyo = 32_000 * 4 / 3 * SECONDS / 1e9       # 16 kHz PCM16 as base64 JSON events
    down_tokyo = 48_000 * 4 / 3 * SECONDS * interviewer / 1e9
    return {
        "CloudFront: mic audio to origin ($0.16/GB India)": up_client * CF_TO_ORIGIN_GB,
        "NAT processing, both directions to Tokyo": (up_tokyo + down_tokyo) * NAT_GB,
        "Inter-region transfer Mumbai -> Tokyo": up_tokyo * INTER_REGION_GB,
        "ALB LCU (processed bytes)": (up_client + down_client) * LCU_H,
        f"CloudWatch Logs ({LOG_MB_PER_INTERVIEW} MB per interview, assumed)": LOG_MB_PER_INTERVIEW / 1000 * CW_LOGS_GB,
    }


def scenario(days_per_month, bill_silence=False, recording=False, price_in=NOVA_IN, price_out=NOVA_OUT,
             interviewer=INTERVIEWER_TALK, minutes=None):
    global SECONDS
    if minutes:
        SECONDS = minutes * 60
    n = STUDENTS * PER_DAY * days_per_month
    nova = nova_per_interview(price_in, price_out, bill_silence, interviewer)
    nova_each = sum(v for k, v in nova.items() if k != "tokens")
    net = network_per_interview(interviewer)
    net_each = sum(net.values())
    lines = {}
    lines["Today's platform (measured, list price)"] = today_month
    lines["Database step-up to db.t4g.small Multi-AZ"] = (RDS_SMALL_MAZ_H - RDS_MICRO_MAZ_H) * HOURS
    lines["API scale-out during interview hours (avg +3 tasks x 12 h)"] = 3 * 12 * days_per_month * TASK_H
    lines["Database storage growth (+1.2 GB/month, incl. backups)"] = 5.0
    lines["Nova 2 Sonic interviews"] = n * nova_each
    down_gb_month = n * 48_000 * SECONDS * interviewer / 1e9
    cf_dto = max(0.0, down_gb_month - CF_FREE_TB * 1000) * CF_DTO_GB
    lines["Network and logs for interviews"] = n * net_each + cf_dto
    lines[f"REEP Agent (Nova Pro, {AGENT_ASKS_PER_STUDENT_MONTH} questions/student/month)"] = (
        STUDENTS * AGENT_ASKS_PER_STUDENT_MONTH * (3000 * PRO_IN + 300 * PRO_OUT) / 1e6)
    lines["Mail (SES, ~10 messages/student/month)"] = STUDENTS * 10 * 0.00016
    if recording:
        tb_month = n * 46.08e6 / 1e12          # two tracks x 24 kHz x 16-bit x 480 s per interview
        tb_live = tb_month * 6                 # 180-day retention
        lines["Recording: EFS Standard (first 30 days)"] = tb_month * 1000 * EFS_STD_GB_MO
        lines["Recording: EFS Infrequent Access (days 31-180)"] = (
            tb_month * 5 * 1000 * EFS_IA_GB_MO + tb_month * 1000 * EFS_IA_WRITE_GB)
        lines["Recording: AWS Backup of EFS, Mumbai + Singapore copy"] = (
            tb_live * 1000 * (BACKUP_EFS_MUMBAI_GB_MO + BACKUP_EFS_SG_GB_MO) + tb_month * 1000 * BACKUP_XREGION_GB)
        lines["Recording: S3 documents archive (never deleted; year-1 average)"] = tb_month * 6.5 * 1000 * S3_STD_GB_MO
    total = sum(lines.values())
    SECONDS = MINUTES * 60
    return dict(n=n, nova=nova, nova_each=nova_each, net=net, net_each=net_each, lines=lines, total=total,
                gst=total * GST, inr_month=total * (1 + GST) * FX, inr_year=total * (1 + GST) * FX * 12)


def show(title, s):
    print(f"\n=== {title}: {s['n']:,} interviews/month ===")
    for k, v in s["lines"].items():
        print(f"  {k:<68} ${v:>9,.0f}")
    print(f"  {'TOTAL before GST':<68} ${s['total']:>9,.0f}")
    print(f"  {'+18% GST':<68} ${s['gst']:>9,.0f}")
    print(f"  per month INR {s['inr_month'] / 1e5:,.2f} lakh | per year INR {s['inr_year'] / 1e7:,.2f} crore"
          f" | per student/month INR {s['inr_month'] / STUDENTS:,.0f}")


if __name__ == "__main__":
    print(f"Today's platform: ${sum(TODAY.values()):.2f}/day = ${today_month:,.0f}/month at list price;"
          f" one api task-hour ${TASK_H:.4f}")
    base = nova_per_interview()
    print("\nPer 8-minute interview (Tokyo prices):")
    for k, v in base.items():
        if k != "tokens":
            print(f"  {k:<12} ${v:.4f}")
    print(f"  tokens (speech in, speech out, text in, text out): {tuple(int(t) for t in base['tokens'])}")
    upper = sum(v for k, v in nova_per_interview(bill_silence=True).items() if k != "tokens")
    print(f"  Nova total ${sum(v for k, v in base.items() if k != 'tokens'):.4f}  | if silence were billed: ${upper:.4f}")
    net = network_per_interview()
    for k, v in net.items():
        print(f"  {k:<64} ${v:.5f}")
    print(f"  network + logs total ${sum(net.values()):.4f}")
    show("A. Every day, recording off", scenario(30))
    show("B. Working days (22), recording off", scenario(22))
    show("C. Every day, upper band (silence billed too)", scenario(30, bill_silence=True))
    show("D. Every day, recording ON", scenario(30, recording=True))
    show("E. Every day, Nova at US-region prices", scenario(30, price_in=NOVA_US_IN, price_out=NOVA_US_OUT))
    show("F. Every day, 6-minute interviews", scenario(30, minutes=6))
    print("\nScaling table (recording off, Tokyo prices):")
    for per_month in (2000, 8600, 20000, 44000, 60000):
        s = scenario(per_month / (STUDENTS * PER_DAY))
        print(f"  {per_month:>7,} interviews/month -> ${s['total']:>8,.0f}/mo before GST,"
              f" INR {s['inr_month'] / 1e5:>6.2f} lakh/mo incl. GST")
    print("\nConcurrency the quota must cover:")
    for window_h in (10, 12, 14):
        avg = STUDENTS * PER_DAY * MINUTES / (window_h * 60)
        print(f"  {window_h} h interview window: average {avg:.0f} simultaneous interviews, 3x peak {3 * avg:.0f}")
