#!/usr/bin/env python3

with open('/Users/mattwilhalme/Desktop/newsboard/docs/index.html', 'r') as f:
    content = f.read()

# Add CSS after the historyItem CSS block
css_to_add = """
    .historyItem.older{
      background: #f8f9fa;
    }"""

# Find the historyItem CSS block and add after it
import re
pattern = r'(\.historyItem\{[^}]+\})'
replacement = r'\1' + css_to_add
content = re.sub(pattern, replacement, content)

# Add JavaScript after row.className = "historyItem"
js_to_add = """
      
      const ageHours = it.since ? (Date.now() - new Date(it.since).getTime()) / (1000 * 60 * 60) : 0;
      if (ageHours > 24) {
        row.classList.add("older");
      }"""

content = content.replace('row.className = "historyItem";', 
                         'row.className = "historyItem";' + js_to_add)

with open('/Users/mattwilhalme/Desktop/newsboard/docs/index.html', 'w') as f:
    f.write(content)

print("Changes applied successfully")
