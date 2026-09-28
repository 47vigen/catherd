# Hallucination Leaderboard

Public LLM leaderboard computed using Vectara's Hallucination Evaluation Model, also known as HHEM. This evaluates how often an LLM introduces hallucinations when summarizing a document. We plan to update this regularly as our model and the LLMs get updated over time.

Feel free to check out the [interactive hallucination leaderboard](https://huggingface.co/spaces/vectara/leaderboard) on Hugging Face. 

If you are interested in previous versions os this leaderboard:
1. First version based on HHEM-1.0, it is available [here](https://github.com/vectara/hallucination-leaderboard/tree/hhem-1.0-final)
2. Most recent version, based on the previous dataset is available [here](https://github.com/vectara/hallucination-leaderboard/tree/hhem-2.3-old-dataset)

<table style="border-collapse: collapse;">
  <tr>
    <td style="text-align: center; vertical-align: middle; border: none;">
      <img src="img/candle.png" width="50" height="50">
    </td>
    <td style="text-align: left; vertical-align: middle; border: none;">
      In loving memory of <a href="https://www.ivinsfuneralhome.com/obituaries/Simon-Mark-Hughes?obId=30000023">Simon Mark Hughes</a>...
    </td>
  </tr>
</table>

<!-- LEADERBOARD_START -->
Last updated on September 22, 2026

![Plot: hallucination rates of various LLMs](./img/top25_hallucination_rates_2026-09-22.png)

|Model|Hallucination Rate|Factual Consistency Rate|Answer Rate|Average Summary Length (Words)|
|----|----:|----:|----:|----:|
|antgroup/finix_s1_32b|1.8 %|98.2 %|99.5 %|172.4|
|openai/gpt-6-sol|6.5 %|93.5 %|100.0 %|71.4|
|google/gemini-2.5-pro|7.0 %|93.0 %|99.1 %|106.4|
|openai/gpt-6-astra|8.7 %|91.3 %|100.0 %|148.5|
|openai/gpt-5.5|9.3 %|90.7 %|100.0 %|129.6|
|anthropic/claude-haiku-4-5-20251001|9.8 %|90.2 %|99.5 %|115.1|

(the rest of the README is cut from this fixture)
