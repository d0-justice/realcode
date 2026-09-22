# 数据库访问约束配置（DATABASES）

> **作用域**：Agent 只读查询环境
> **核心原则**：白名单 + 黑名单双重机制。白名单显式列出可访问的表，黑名单通过前缀/模式批量拦截系统类、日志类、备份类等表。命中任意一条规则即生效。
> **环境绑定**：连接类型、引擎、数据库由 `.agents/ENVIRONMENTS.md` 定义，本文档定义表级和字段级的可访问性与处理规则。

---

## 1. 可访问表白名单（Table Allow-List）

Agent 仅允许对以下白名单中的表执行 `SELECT` 操作。任何涉及其他表的查询请求将被拒绝。

### 1.1 Doris 表（`create_connection("doris")`, database: `laims`）

| 表名 | 业务含义 | 主 Skill | 查询限制 |
| :--- | :--- | :--- | :--- |
| `t_flight_dynamic_report` | 飞行动态点（大表，上亿级） | `t-flight-dynamic-report-skill` | **必须有界 `time_stamp` 条件**；禁止无界扫表 |

> **关联 Skills**（均基于本表）：`route-corridor-sortie-extract-skill`、`province-high-altitude-sortie-extract-skill`、`flight-density-heatmap-skill`、`flight-altitude-heatmap-skill`、`flight-task-geo-distribution-skill`、`route-blockage-map-skill`、`uav-auth-skill`、`agri-uav-skill`、`sn-flight-stat-skill`

### 1.2 MySQL 表（`create_connection("mysql")`, database: `laims`）

#### 飞行动态与飞行计划类

| 表名 | 业务含义 | 主 Skill | 查询限制                                         |
| :--- | :--- | :--- |:---------------------------------------------|
| `t_find_uom_plan` | 一般/紧急飞行活动申请 | `flight-mission-skill` | 只读；含申请人姓名和证件号码，见 §2.2，使用时提示用户该表数据已不再更新，数据不准确 |
| `t_flight_activity_application` | 飞行活动申请 | — | 只读；使用前先确认字段和业务口径，使用时提示用户该表数据仍在调试中，数据不准确      |


#### 基础信息（人员/企业/设备）

| 表名 | 业务含义                 | 主 Skill | 查询限制 |
| :--- |:---------------------| :--- | :--- |
| `t_person_info` | 飞手基础信息(个人认证)         | — | **禁止返回原始敏感字段**（姓名/手机/身份证），见 §2.2 |
| `t_plan_uav_driver` | 飞行活动申请的航空器和操控员列表     | — | 含操控员姓名和证件号码，见 §2.2 |
| `t_uav_unit_info` | 飞行企业基础信息             | — | 只读；含电话号码（phone_number）和联系人，见 §2.2 |
| `t_base_airport_collection` | 机场合集信息               | — | 只读；含联系电话（phone），经纬度为 decimal 类型 |
| `t_base_slot_device` | 智联网设备清单              | — | 只读；含经纬度坐标（varchar） |

#### 无人机注册与资源类

| 表名 | 业务含义 | 主 Skill | 查询限制 |
| :--- | :--- | :--- | :--- |
| `t_uas_info` | 无人机注册基础信息 | — | 只读 |

#### 起降场地类

| 表名 | 业务含义        | 主 Skill | 查询限制 |
| :--- |:------------| :--- | :--- |
| `t_uav_takeoff_landing_site` | 起降场（点）含机巢信息 | — | 只读；含联系人（contact）和联系方式（contact_phone），见 §2.2 |


> 🚫 **未列入白名单的表不可访问**。即使数据库中存在，Agent 也无法查询。

### 1.3 禁止访问表模式（Table Blacklist Patterns）

除白名单外，以下前缀或模式匹配的表**一律禁止访问**，无需逐一枚举。

| 模式 | 匹配说明 | 示例（被拦截） |
| :--- | :--- | :--- |
| `t_sys_*` | 系统配置/内部管理类表 | `t_sys_config`、`t_sys_user`、`t_sys_role`、`t_sys_permission` |
| `t_log_*` | 日志/审计类表 | `t_log_operation`、`t_log_login`、`t_log_access` |
| `t_admin_*` | 后台管理类表 | `t_admin_user`、`t_admin_operation` |
| `t_internal_*` | 内部工具/运维类表 | `t_internal_config`、`t_internal_monitor` |
| `t_backup_*` | 备份/归档类表 | `t_backup_*`、`t_archive_*` |
| `*_bak` / `*_backup` | 备份表（后缀） | `t_flight_dynamic_report_bak`、`t_uas_info_backup` |
| `information_schema.*` | MySQL 系统库 | 所有 `information_schema` 表 |
| `performance_schema.*` | MySQL 性能库 | 所有 `performance_schema` 表 |

**匹配规则**：
- 以 `t_sys_`、`t_log_`、`t_admin_`、`t_internal_`、`t_backup_`、`t_archive_` 开头的表，无论后缀是什么，一律拦截。
- 以 `_bak`、`_backup` 结尾的表，无论前缀是什么，一律拦截。
- 白名单优先于黑名单：若某表同时命中白名单和黑名单模式，以**白名单为准**（但正常不应对白名单表使用黑名单前缀命名）。
- 新增黑名单模式只需在本节追加，无需修改白名单。

**拦截行为**：命中黑名单的表在 SQL 解析阶段直接拒绝，返回：
```
ERROR_TABLE_BLACKLISTED: 表 'xxx' 命中黑名单模式 '<pattern>'，禁止访问。
```

---

## 2. 各表特殊字段处理规则（Field-Level Processors）

以下规则定义了 Agent 在查询和输出时必须遵守的字段转换与脱敏规范。

### 2.1 `t_flight_dynamic_report` 表

#### 坐标字段

| 字段名 | 处理类型 | 强制转换逻辑 |
| :--- | :--- | :--- |
| `longitude` | **坐标转换** | 存储为 `degree × 10000000` 的 `BIGINT`。地图、GeoJSON、空间计算输出时必须 `/ 10000000.0` 转为十进制度。SQL bbox 粗筛可用原始整数值。 |
| `latitude` | **坐标转换** | 同上。 |
| `coordinate` | **枚举** | `1` = WGS-84，`2` = CGCS2000，`3~15` 预留。不作为连续数值计算。 |

无效坐标过滤：`0,0`、`-10000000|-10000000`、`NULL` 一律视为无效，正常分析中排除。

#### 高度/速度/航向字段（一位小数物理量）

以下字段存储值为物理量 `× 10`，输出时 `/ 10.0`。`-999999` 为缺失哨兵值，转换为 `NULL`：

| 字段名 | 物理含义 | 转换 | 哨兵值处理 |
| :--- | :--- | :--- | :--- |
| `height` | 真高/相对高度 (m) | `÷ 10.0` | `-999999` → `NULL` |
| `t_height` | 真高 (m)（当前全为 NULL） | `÷ 10.0` | 当前不可用，使用 `height` 代替 |
| `geodetic_height` | 大地高度/海拔 (m) | `÷ 10.0` | `-999999` → `NULL` |
| `pressure_height` | 气压高度 (m) | `÷ 10.0` | `-999999` → `NULL` |
| `vs` | 垂直速度 (m/s) | `÷ 10.0` | `-999999` → `NULL` |
| `gs` | 地面速度 (m/s) | `÷ 10.0` | `-999999` → `NULL` |
| `course` | 航迹角 (°) | `÷ 10.0`；范围 `[0, 359.9]` | `-999999` → `NULL` |
| `uav_control_station_site_height` | 遥控站高度 (m) | `÷ 10.0` | `-999999` → `NULL` |

#### 时间字段

| 字段名 | 处理类型 | 规则 |
| :--- | :--- | :--- |
| `time_stamp` | **时间格式** | 格式 `yyyyMMddHHmmss`；必须带界条件；排除哨兵值 `19691231235959` |
| `create_time` | **区分** | 数据库写入时间，非飞行时间，不作为业务时间使用 |
| `update_time` | **区分** | 数据库更新时间，非飞行时间，不作为业务时间使用 |

#### 枚举和精度字段

以下字段为枚举/等级，按对应码表解释，**不得当连续数值计算**：

| 字段名 | 类型 | 规则 |
| :--- | :--- | :--- |
| `uav_opt_category` | 运行类别 | `0` 未定义，`1` 开放类，`2` 特定类，`3` 审定类 |
| `uav_category` | 无人机分类 | `0` 微型，`1` 轻型，`2` 小型，`3` 中型，`4` 大型 |
| `operating_status` | 运行状态 | `0` 未报告，`1` 地面，`2` 空中，`3` 紧急状态等 |
| `horizontal_accuracy` | 水平精度 | `0`~`12` 等级（≥18.52km ~ <1m） |
| `vertical_accuracy` | 垂直精度 | `0`~`6` 等级（≥150m ~ <1m） |
| `speed_accuracy` | 速度精度 | `0`~`4` 等级（≥10m/s ~ <0.3m/s） |
| `time_stamp_accuracy` | 时间戳精度 | `0`~`8` 等级（>0.5s ~ ≤10ms） |
| `uav_control_station_site_type` | 遥控站位置类型 | `0` 起飞点，`1` 遥控站 |

#### 飞行标识与分组键

| 任务类型 | 默认分组键 | 说明 |
| :--- | :--- | :--- |
| 点密度/网格/地理分布 | 原始点行 | 不需要去重 |
| 产品/飞行器计数 | `upic_msn` | 按产品序列号去重 |
| 架次抽取、架次统计、飞行次数、sortie | `fp_id` | 仅统计非空 `fp_id`；所有架次缓存、进度表和分组均使用此键 |
| 原始动态记录追溯 | `order_id` | 可作为辅助展示字段，不得用于架次去重、分组或计数 |

不同键不可混用，输出时必须说明所用口径。架次口径固定为 `fp_id`，并在 SQL 中显式过滤 `fp_id IS NOT NULL AND fp_id <> ''`。

#### `uav_auth_info` JSON 字段

**存储格式**：明文 JSON（非加密）。详细掩码规则见 §3。

**常用非敏感字段**（聚合/分组可用）：
`uas`、`uavName`、`uavModel`、`uavManufacturer`、`uavEmptyWeight`、`uavMaxWeight`、`uavUserType`、`uavCategory`、`uavType`

**SQL 提取示例**（仅非敏感字段）：
```sql
GET_JSON_OBJECT(uav_auth_info, '$.uas') AS uas,
GET_JSON_OBJECT(uav_auth_info, '$.uavName') AS uav_name,
GET_JSON_OBJECT(uav_auth_info, '$.uavUserType') AS uav_user_type
```

> ⚠️ 禁止在 SQL 中提取 `$.uavPerson.name`、`$.uavPerson.phoneNumber`、`$.uavPerson.idnumber`、`$.uavUnit.phoneNumber`，除非 §3 规定的授权场景。

### 2.2 其他表

#### 含个人敏感信息（PII）的表

以下表涉及姓名、手机号、身份证号/证件号、联系方式等，必须遵守 §3 掩码规则：

| 表名 | 敏感字段 | 处理规则 |
| :--- | :--- | :--- |
| `t_person_info` | `name`（人员名称）、`tel`（电话）、`id_no`（证件号码）、`license`（飞行执照编号） | 禁止直接暴露原始值；聚合统计优先；内部导出掩码 |
| `t_base_pilot` | `pilot_name`（飞手姓名）、`phone`（联系电话）、`idcard`（证件号码）、`email`（邮箱） | 同上 |
| `t_find_uom_plan` | `user_name`（申请人）、`person_card_no`（证件号码） | 同上 |
| `t_plan_uav_driver` | `uavrp_name`（操控员姓名）、`uavrp_cert_no`（操控员证件号码） | 同上 |
| `t_uav_unit_info` | `phone_number`（电话号码）、`unit_contact`（单位联系人） | 聚合优先；明细需脱敏 |
| `t_base_enterprise` | `interact_name`（联系方式）、`interact_tel`（联系方式） | 聚合优先；明细需脱敏 |
| `t_uav_resource` | `contactname`（联系人名称）、`unit_person`（单位联系人）、`unit_phone`（单位联系方式） | 聚合优先；明细需脱敏 |
| `t_uav_takeoff_landing_site` | `contact`（起降点联系人）、`contact_phone`（联系方式） | 聚合优先；明细需脱敏 |
| `t_uav_operator_info` | `contact`（联系人）、`phone`（联系电话） | 聚合优先；明细需脱敏 |
| `t_ga_airspace_req` | `contact_person`（联系人）、`contact_details`（联系方式）、`pilot`（飞行员信息）、`aircrew`（机组人员信息） | 聚合优先；明细需脱敏 |
| `t_ga_filing_fly_plan_report` | `contact_person`（联系人）、`contact_details`（联系方式）、`pilot`（飞行员信息）、`aircrew`（机组人员信息） | 同上 |
| `t_temp_airsapce` | `tel`（联系电话） | 聚合优先；明细需脱敏 |
| `t_base_airport_collection` | `phone`（联系电话） | 聚合优先；明细需脱敏 |

#### 含 text/longtext JSON 响应体的表

以下表的 `req_body`、`body`、`data` 等字段存储 JSON/text 响应数据，**可能间接包含个人信息**。提取前需确认内容不包含 §3 所列敏感字段：

| 表名 | JSON/Text 字段 | 处理规则 |
| :--- | :--- | :--- |
| `t_operator_info` | `req_body`、`body`（text） | 提取内容前检查是否含 PII |
| `t_opt_cert` | `req_body`、`body`（longtext） | 同上 |
| `t_uav_reg_info` | `req_body`、`body`（longtext） | 同上 |
| `t_verify_uav_reg_status` | `req_body`、`body`（text） | 同上 |
| `t_flyinglist` | `data`（longtext） | 同上 |
| `t_approval_status` | `data`（text） | 同上 |
| `t_takeoff_confirm` | `uav_and_driver`（text JSON） | 同上；含操控员信息 |
| `t_uav_fly_plan` | `operators`（text）、`subject`（text）、`uass`（text） | 同上；含操作人和航空器 JSON |
| `t_task_file` | `file_data`（longtext Base64） | 文件内容不可直接输出；只读 |

#### 含坐标/空间的表（非 BIGINT 编码）

以下表坐标字段为 decimal 或 varchar 类型，与 `t_flight_dynamic_report` 的 `BIGINT` 编码不同，**不需要 `/ 10000000.0` 换算**：

| 表名 | 坐标字段 | 类型 |
| :--- | :--- | :--- |
| `t_base_airport_collection` | `longitude`、`latitude` | `decimal(12,7)`，已是十进制度 |
| `t_uav_operator_info` | `longitude`、`latitude` | `decimal(10,6)`，已是十进制度 |
| `t_uav_resource` | `longitude`、`latitude` | `decimal(15,7)`，已是十进制度 |
| `t_base_slot_device` | `coordinates` | `varchar(32)`，格式需确认 |
| `t_uav_takeoff_landing_site` | `pnt_loc` | `varchar(128)`，格式需确认 |
| `t_plan_space` | `location` | `varchar(4096)`，坐标列表 |
| `t_space_way_report` | `points` | `longtext`，航路航线路径点 |

#### 其他一般表

以下表字段无特殊处理要求，默认只读：

`t_uas_info`、`t_uav_takeoff_land_record_his`、`t_uav_takeoff_land_record`、`t_flight_activity_application`、`t_daily_takeoff_land_statistics`、`t_landing_report`、`t_land_site_report`、`t_mqtt_daily_record`、`t_mqtt_daily_record_his`、`t_mqtt_daily_record_statistics`、`t_base_aircraft`、`t_base_id_key`、`t_base_slot_device`、`t_operator_certificate`、`t_ga_fly_plan`、`t_ga_fly_plan_cancel`、`t_ga_fly_plan_vf`、`t_ga_flight_confirm`、`t_ga_flight_status`、`t_ga_file`、`t_ga_msg_ack`、`t_uav_airspace_req`、`t_uav_fly_plan`、`t_uav_wayline`、`t_space_way_report`、`t_longterm_filing`、`t_temp_airsapce_area`、`t_visualize_grapes`、`t_visualize_wind`、`t_ztf_real_time_data`、`t_ztf_statistics_data`

> 以上表使用前先确认字段存在且口径明确。涉及企业联系方式或个人信息的字段参照 §3 掩码规则。

---

## 3. 敏感字段掩码规范（Sensitive Data Masking）

### 3.1 `uav_auth_info` JSON 敏感字段

`uav_auth_info` 是无人机实名登记 JSON，根据 `uavUserType` 区分个人（`0`）和企业（`1`）用户。

**敏感字段清单及掩码规则**：

| JSON Path | 内容 | 掩码方式 | 示例 |
| :--- | :--- | :--- | :--- |
| `$.uavPerson.name` | 飞手姓名 | 保留姓，名掩码为 `*`；单名保留首字 | `张三` → `张*`；`张三丰` → `张*丰` |
| `$.uavPerson.phoneNumber` | 手机号 | 保留前 3 后 4，中间掩码 | `13812341234` → `138****1234` |
| `$.uavPerson.idnumber` | 身份证号 | 保留首尾各 1 位，中间掩码 | `440101199001011234` → `4****************4` |
| `$.uavUnit.phoneNumber` | 企业联系电话 | 保留前 3~4 位（区号+前1），后 4 位，中间掩码 | `02087654321` → `020****4321` |

**企业用户非敏感字段**（`uavUnit` 中不涉及个人的字段可正常使用）：
`usccode`（统一社会信用代码）、`unitType`、`unitName`

### 3.2 其他含敏感字段的表

以下 MySQL 表中的敏感字段，掩码规则与 §3.1 一致：

| 表名 | 敏感字段 | 掩码规则 |
| :--- | :--- | :--- |
| `t_person_info` | `name`（姓名）、`tel`（电话）、`id_no`（证件号码）、`license`（飞行执照编号） | 姓名 → `mask_name`；电话 → `mask_phone`；证件号 → `mask_idnumber` |
| `t_base_pilot` | `pilot_name`（飞手姓名）、`phone`（联系电话）、`idcard`（证件号码）、`email`（邮箱） | 姓名/电话/证件号同上；邮箱 → 保留首字符和域名，如 `t***@example.com` |
| `t_find_uom_plan` | `user_name`（申请人姓名）、`person_card_no`（证件号码） | 同上 |
| `t_plan_uav_driver` | `uavrp_name`（操控员姓名）、`uavrp_cert_no`（操控员证件号码） | 同上 |
| `t_uav_unit_info` | `phone_number`（电话号码）、`unit_contact`（单位联系人） | 电话 → `mask_phone`；联系人 → `mask_name` |
| `t_base_enterprise` | `interact_name`（联系方式）、`interact_tel`（联系方式） | 同上 |
| `t_uav_resource` | `contactname`（联系人）、`unit_person`（单位联系人）、`unit_phone`（单位联系方式） | 同上 |
| `t_uav_takeoff_landing_site` | `contact`（联系人）、`contact_phone`（联系方式） | 同上 |
| `t_uav_operator_info` | `contact`（联系人）、`phone`（联系电话） | 同上 |
| `t_ga_airspace_req` | `contact_person`、`contact_details`、`pilot`、`aircrew` | text 字段，提取后按对应类型掩码 |
| `t_ga_filing_fly_plan_report` | `contact_person`、`contact_details`、`pilot`、`aircrew` | 同上 |
| `t_temp_airsapce` | `tel`（联系电话） | `mask_phone` |
| `t_base_airport_collection` | `phone`（联系电话） | `mask_phone` |

### 3.3 聚合统计豁免

当输出仅为聚合数字（如"本月实名无人机数量 1,234 台"），且不包含任何原始字段值时，**无需掩码**。

### 3.4 内部授权导出

以下场景可输出原始值，但需满足全部条件：
1. 用户**显式要求**内部受控导出
2. 输出文件名包含 `_internal_` 前缀和时间戳
3. 文件交付后提醒用户妥善保管

### 3.5 Python 掩码函数参考实现

```python
import re

def mask_name(name: str) -> str:
    """掩码姓名：保留姓，名用 * 替换。"""
    if not name or len(name) < 2:
        return "*"
    return name[0] + "*" * (len(name) - 1)

def mask_phone(phone: str) -> str:
    """掩码手机号：保留前 3 后 4。"""
    if not phone or len(phone) < 7:
        return "***"
    return phone[:3] + "****" + phone[-4:]

def mask_idnumber(idnum: str) -> str:
    """掩码身份证号：保留首尾各 1 位。"""
    if not idnum or len(idnum) < 4:
        return "***"
    return idnum[0] + "*" * (len(idnum) - 2) + idnum[-1]

# 通用 JSON 敏感字段掩码函数
def mask_uav_auth_sensitive(auth_info: dict) -> dict:
    """对 uav_auth_info JSON 中的敏感字段进行掩码。"""
    import copy
    masked = copy.deepcopy(auth_info)
    person = masked.get("uavPerson")
    if person:
        if "name" in person:
            person["name"] = mask_name(person["name"])
        if "phoneNumber" in person:
            person["phoneNumber"] = mask_phone(person["phoneNumber"])
        if "idnumber" in person:
            person["idnumber"] = mask_idnumber(person["idnumber"])
    unit = masked.get("uavUnit")
    if unit and "phoneNumber" in unit:
        unit["phoneNumber"] = mask_phone(unit["phoneNumber"])
    return masked
```

---

## 4. 查询执行约束（Runtime Rules）

以下约束在 SQL 执行前校验，不满足则拦截或自动修正。

1. **强制 LIMIT**：所有 `SELECT` 必须包含 `LIMIT`，最大值 `1000`。未提供时自动追加 `LIMIT 100`。
2. **禁止 `SELECT *`**：必须显式列出所需字段。未在白名单中的字段将被拒绝。
3. **时间边界强制**：
   - `t_flight_dynamic_report` 的 `WHERE` 中必须包含有界 `time_stamp` 条件。
   - 未提供时间窗时，默认限定最近 **7 天**，并在结果中说明。
4. **行过滤默认值**：
   - `t_flight_dynamic_report`：排除 `time_stamp = '19691231235959'`。
   - 坐标/高度哨兵值自动过滤（见 §2.1）。
5. **禁止跨表隐式笛卡尔积**：JOIN 必须有明确且有效的关联条件。
6. **敏感字段提取拦截**：若 SQL 中包含 §3 所列敏感 JSON 路径，必须确认用户授权，否则拒绝执行。

---

## 5. 错误提示规范

当 Agent 违反上述约束时，返回以下格式的错误信息：

| 错误码 | 消息 |
| :--- | :--- |
| `ERROR_TABLE_BLACKLISTED` | 表 'xxx' 命中黑名单模式 '\<pattern\>'，禁止访问。 |
| `ERROR_TABLE_NOT_ALLOWED` | 表 'xxx' 不在访问白名单中，请检查 DATABASES.md。 |
| `ERROR_FIELD_FORBIDDEN` | 字段 'xxx' 无访问权限或不在白名单中。 |
| `ERROR_MISSING_TIME_FILTER` | 查询 `t_flight_dynamic_report` 必须指定 `time_stamp` 范围。 |
| `ERROR_NO_LIMIT` | 查询缺少 LIMIT 子句，已自动添加 LIMIT 100。 |
| `ERROR_SENSITIVE_FIELD` | 字段 'xxx' 包含敏感信息，请确认授权或改为聚合查询。 |
| `ERROR_SENTINEL_NOT_FILTERED` | 查询未排除哨兵值（如 `-999999`、`19691231235959`），已自动过滤。 |

---

## 6. API Key 与凭证管理

1. **环境变量优先**：AMap JSAPI Key（`AMAP_JSAPI_KEY`）、WebService Key（`AMAP_WEBSERVICE_KEY`）、Security JS Code（`AMAP_SECURITY_JS_CODE`）必须从环境变量读取。
2. **禁止硬编码**：脚本中不得硬编码 API Key 作为 fallback 值。若环境变量缺失，脚本应报错退出并提示设置。
3. **Key 不可混用**：JSAPI Key 用于浏览器端地图，WebService Key 用于服务端 API 调用，不能互换。
4. **数据库凭证**：数据库主机、端口、账号、密码不写入本文档或任何 answer/输出文件。

---

## 维护规则

- 新增业务表时，先在对应业务 skill 说明字段和口径，再在本文档登记访问权限和处理规则。
- 字段处理规则变更时，同步更新本文档和对应 skill 的 `references/`。
- 敏感字段清单变更时，同步更新 `SOUL.md` 和本文档 §3。
