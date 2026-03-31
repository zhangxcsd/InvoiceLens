FIELD_MAPPING = {
    "invoice_no": ["发票号码", "发票号", "号码"],
    "invoice_code": ["发票代码", "代码"],
    # 数电票关键识别号：用于数电发票逻辑分组与 key 判定
    "sdfphm": ["数电发票号码", "数电票号码", "数电发票号", "数电票号"],
    "invoice_date": ["开票日期", "日期"],
    "seller_tax_no": ["销方税号", "销方税务登记号"],
    "buyer_tax_no": ["购方税号", "购方税务登记号"],
    "amount": ["金额", "不含税金额"],
    "tax_amount": ["税额"],
    "total_amount": ["价税合计", "含税金额"],
}
